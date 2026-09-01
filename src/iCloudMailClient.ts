import ICloudClient from './iCloudClient';

const MAIL_CLIENT_BUILD_NUMBER = '2624Build13';
const DEFAULT_SCAN_THREADS = 80;
const MAX_METADATA_CONCURRENCY = 6;

type ThreadDigest = {
  threadId?: string;
  timestamp?: number;
};

type ThreadSearchResponse = {
  totalThreadsReturned?: number;
  threadList?: ThreadDigest[];
};

type MessageMetadata = {
  uid?: string;
  date?: number;
  sentDate?: string;
  folder?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
};

type ThreadMetadataResponse = {
  messageMetadataList?: MessageMetadata[];
};

export type MailActivityScanResult = {
  lastReceivedByAlias: Record<string, number>;
  scannedThreads: number;
  scannedAt: number;
};

const normalizeTimestamp = (value: number | undefined): number | undefined => {
  if (!value || !Number.isFinite(value)) return undefined;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const parseDateString = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const normalizeAddress = (value: string) => value.trim().toLocaleLowerCase();

const stringsContainAlias = (values: Array<string[] | undefined>, alias: string) => {
  const normalized = normalizeAddress(alias);
  return values
    .flatMap((value) => value || [])
    .some((value) => value.toLocaleLowerCase().includes(normalized));
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
};

export class ICloudMailClient {
  private readonly clientId = crypto.randomUUID();
  private readonly baseUrl: string;
  private readonly dsid: string;

  constructor(private readonly client: ICloudClient) {
    this.baseUrl = client.webserviceUrl('mccgateway');
    if (!client.dsid) {
      throw new Error('iCloud Mail activity is unavailable until the iCloud session is refreshed.');
    }
    this.dsid = client.dsid;
  }

  private endpoint(path: string): string {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('clientBuildNumber', MAIL_CLIENT_BUILD_NUMBER);
    url.searchParams.set('clientMasteringNumber', MAIL_CLIENT_BUILD_NUMBER);
    url.searchParams.set('clientId', this.clientId);
    url.searchParams.set('dsid', this.dsid);
    return url.toString();
  }

  private async post<T>(path: string, data: Record<string, unknown>): Promise<T> {
    return (await this.client.request('POST', this.endpoint(path), {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      data,
    })) as T;
  }

  async listRecentThreads(maxResults = DEFAULT_SCAN_THREADS): Promise<ThreadDigest[]> {
    const response = await this.post<ThreadSearchResponse>('/mailws2/v1/thread/search', {
      responseType: 'THREAD_DIGEST',
      includeFolderStatus: false,
      maxResults,
      before: '',
      sessionHeaders: {
        folder: 'INBOX',
        condstore: 1,
        qresync: 1,
        threadmode: 1,
      },
    });
    return response.threadList || [];
  }

  async getThreadMetadata(threadId: string): Promise<MessageMetadata[]> {
    const response = await this.post<ThreadMetadataResponse>('/mailws2/v1/thread/get', {
      threadId,
      includeLabelIds: false,
      sessionHeaders: {
        folder: 'INBOX',
        condstore: 1,
        qresync: 1,
        threadmode: 1,
      },
    });
    return response.messageMetadataList || [];
  }

  async scanRecentAliasActivity(
    aliases: string[],
    maxThreads = DEFAULT_SCAN_THREADS
  ): Promise<MailActivityScanResult> {
    const aliasLookup = new Map(aliases.map((alias) => [normalizeAddress(alias), alias]));
    const lastReceivedByAlias: Record<string, number> = {};
    const threads = await this.listRecentThreads(maxThreads);

    await mapWithConcurrency(threads, MAX_METADATA_CONCURRENCY, async (thread) => {
      if (!thread.threadId) return;
      let metadata: MessageMetadata[];
      try {
        metadata = await this.getThreadMetadata(thread.threadId);
      } catch (error) {
        console.debug('Unable to inspect iCloud Mail thread metadata', thread.threadId, error);
        return;
      }

      for (const message of metadata) {
        if (message.folder && message.folder !== 'INBOX') continue;
        const fallbackTimestamp = normalizeTimestamp(thread.timestamp);
        const timestamp =
          normalizeTimestamp(message.date) || parseDateString(message.sentDate) || fallbackTimestamp;
        if (!timestamp) continue;

        for (const [normalizedAlias, originalAlias] of aliasLookup) {
          if (!stringsContainAlias([message.to, message.cc, message.bcc], normalizedAlias)) continue;
          lastReceivedByAlias[originalAlias] = Math.max(
            lastReceivedByAlias[originalAlias] || 0,
            timestamp
          );
        }
      }
    });

    return {
      lastReceivedByAlias,
      scannedThreads: threads.length,
      scannedAt: Date.now(),
    };
  }
}

export const isICloudMailForwardingAddress = (email: string | undefined): boolean => {
  if (!email) return false;
  const domain = email.split('@').pop()?.toLocaleLowerCase();
  return domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com';
};
