import ICloudClient from './iCloudClient';
import { extractMailVerificationCode } from './mailVerificationCode';

const MAIL_CLIENT_BUILD_NUMBER = '2624Build13';
const DEFAULT_SCAN_THREADS = 80;
const MAX_METADATA_CONCURRENCY = 6;

type ThreadDigest = {
  threadId?: string;
  timestamp?: number;
  subject?: unknown;
  snippet?: unknown;
  preview?: unknown;
  messageSnippet?: unknown;
  sender?: unknown;
  from?: unknown;
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
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  from?: unknown;
  sender?: unknown;
  subject?: unknown;
  snippet?: unknown;
  preview?: unknown;
  messageSnippet?: unknown;
  bodyPreview?: unknown;
};

type ThreadMetadataResponse = {
  messageMetadataList?: MessageMetadata[];
};

export type MailActivityScanResult = {
  lastReceivedByAlias: Record<string, number>;
  scannedThreads: number;
  scannedAt: number;
};

export type RecentAliasMessage = {
  id: string;
  threadId: string;
  timestamp: number;
  sender: string;
  subject: string;
  preview?: string;
  verificationCode?: string;
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

const collectKnownText = (value: unknown): string[] => {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(collectKnownText);
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  return [
    record.email,
    record.emailAddress,
    record.address,
    record.name,
    record.displayName,
    record.value,
  ].flatMap(collectKnownText);
};

const firstKnownText = (...values: unknown[]): string | undefined =>
  values.flatMap(collectKnownText).find((value) => value.length > 0);

const stringsContainAlias = (values: unknown[], alias: string) => {
  const normalized = normalizeAddress(alias);
  return values
    .flatMap(collectKnownText)
    .some((value) => value.toLocaleLowerCase().includes(normalized));
};

const cleanPreview = (
  value: string | undefined,
  maxLength = 180
): string | undefined => {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength - 1).trimEnd()}…`
    : cleaned;
};

const senderLabel = (
  message: MessageMetadata,
  thread: ThreadDigest
): string => {
  const raw = firstKnownText(
    message.from,
    message.sender,
    thread.from,
    thread.sender
  );
  if (!raw) return '';
  const bracketed = raw.match(/^\s*([^<]+?)\s*<[^>]+>\s*$/);
  return cleanPreview(bracketed?.[1] || raw, 90) || '';
};

const messageSubject = (
  message: MessageMetadata,
  thread: ThreadDigest
): string =>
  cleanPreview(firstKnownText(message.subject, thread.subject), 140) || '';

const messagePreview = (
  message: MessageMetadata,
  thread: ThreadDigest
): string | undefined =>
  cleanPreview(
    firstKnownText(
      message.snippet,
      message.preview,
      message.messageSnippet,
      message.bodyPreview,
      thread.snippet,
      thread.preview,
      thread.messageSnippet
    )
  );

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
      }
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
      }
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

  async listRecentMessagesForAlias(
    alias: string,
    maxThreads = DEFAULT_SCAN_THREADS,
    limit = 6
  ): Promise<RecentAliasMessage[]> {
    const normalizedAlias = normalizeAddress(alias);
    if (!normalizedAlias || limit <= 0) return [];

    const threads = await this.listRecentThreads(maxThreads);
    const candidates = await mapWithConcurrency(
      threads,
      MAX_METADATA_CONCURRENCY,
      async (thread): Promise<RecentAliasMessage | undefined> => {
        if (!thread.threadId) return undefined;

        let metadata: MessageMetadata[];
        try {
          metadata = await this.getThreadMetadata(thread.threadId);
        } catch (error) {
          console.debug(
            'Unable to inspect iCloud Mail thread metadata',
            thread.threadId,
            error
          );
          return undefined;
        }

        const matches = metadata
          .filter((message) => !message.folder || message.folder === 'INBOX')
          .filter((message) =>
            stringsContainAlias(
              [message.to, message.cc, message.bcc],
              normalizedAlias
            )
          )
          .map((message) => ({
            message,
            timestamp:
              normalizeTimestamp(message.date) ||
              parseDateString(message.sentDate) ||
              normalizeTimestamp(thread.timestamp) ||
              0,
          }))
          .filter((candidate) => candidate.timestamp > 0)
          .sort((left, right) => right.timestamp - left.timestamp);

        const latest = matches[0];
        if (!latest) return undefined;

        const subject = messageSubject(latest.message, thread);
        const preview = messagePreview(latest.message, thread);
        return {
          id: latest.message.uid || thread.threadId,
          threadId: thread.threadId,
          timestamp: latest.timestamp,
          sender: senderLabel(latest.message, thread),
          subject,
          preview,
          verificationCode: extractMailVerificationCode(
            `${subject}\n${preview || ''}`
          ),
        };
      }
    );

    return candidates
      .filter((message): message is RecentAliasMessage => message !== undefined)
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, Math.max(1, Math.min(limit, 20)));
  }
}

export const isICloudMailForwardingAddress = (email: string | undefined): boolean => {
  if (!email) return false;
  const domain = email.split('@').pop()?.toLocaleLowerCase();
  return domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com';
};
