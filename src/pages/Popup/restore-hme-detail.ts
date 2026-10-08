import browser from 'webextension-polyfill';
import type ICloudClient from '../../iCloudClient';
import type { HmeEmail } from '../../iCloudClient';
import { ManagedPremiumMailSettings } from '../../hmeService';
import { hmeListCacheKey } from '../../hmeRepository';
import { matchHmeAliases } from '../../hme-site-matching';
import { isICloudMailForwardingAddress } from '../../iCloudMailClient';
import { sanitizeManagerView, selectManagedAddresses } from './management-model';

type Address = HmeEmail & { lastReceivedAt?: number; activityStatus?: 'unavailable' | 'ready' | 'idle' };
type RestoredDetail = { selected?: Address; addresses: Address[] };

const statusOf = (error: unknown) => (error as { status?: number } | undefined)?.status;
const isAuthenticationFailure = (error: unknown) => [401, 403].includes(statusOf(error) || 0);
const isTransientFailure = (error: unknown) => {
  const status = statusOf(error);
  return !status || status === 408 || status === 429 || status >= 500;
};

/** Resolve only routing metadata against the current account; never replay a fill or mail scan. */
export async function restoreHmeDetail(
  client: ICloudClient,
  anonymousId: string,
  options: { isManager: boolean; search?: string; getCurrentHost: () => Promise<string> },
): Promise<RestoredDetail> {
  if (!anonymousId) return { addresses: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const timeoutError = new Error('Restoring the saved address timed out. Please retry.');
  const checkDeadline = () => { if (expired) throw timeoutError; };
  const read = async (): Promise<RestoredDetail> => {
    const service = new ManagedPremiumMailSettings(client);
    let emails: HmeEmail[];
    let forwardTo: string | undefined;
    let listFailure: unknown;
    try {
      const list = await service.listHme(false);
      emails = list.hmeEmails;
      forwardTo = list.selectedForwardTo;
    } catch (error) {
      checkDeadline();
      if (!isTransientFailure(error)) throw error;
      listFailure = error;
      const cached = await service.snapshot();
      if (!cached) throw error;
      emails = cached.emails;
      forwardTo = cached.forwardTo;
    }
    checkDeadline();
    if (!Array.isArray(emails)) throw new Error('Invalid iCloud address-list response.');
    if (!emails.some((item) => item.anonymousId === anonymousId)) {
      if (listFailure) throw listFailure;
      return { addresses: [] };
    }

    const accountKey = hmeListCacheKey(client);
    const viewKey = `hme-manager-view:${accountKey}`;
    const activityKey = `hme-mail-activity:${accountKey}`;
    const stored: Record<string, unknown> = await browser.storage.local.get([viewKey, activityKey]).catch(() => ({}));
    checkDeadline();
    const presentation = sanitizeManagerView(stored[viewKey]);
    if (options.isManager && presentation.filter === 'current') presentation.filter = 'all';
    const activityCache = stored[activityKey] as { byAlias?: Record<string, unknown>; lastScanAt?: unknown } | undefined;
    const activity = activityCache?.byAlias;
    const scannedAt = activityCache?.lastScanAt;
    const hasScan = typeof scannedAt === 'number' && Number.isFinite(scannedAt) && scannedAt > 0;
    const hasMailService = !!client.dsid && client.hasWebservice('mccgateway');
    const withActivity: Address[] = emails.map((item) => {
      const timestamp = activity?.[item.hme];
      return {
        ...item,
        lastReceivedAt: typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined,
        activityStatus: !hasMailService || !isICloudMailForwardingAddress(forwardTo || item.forwardToEmail)
          ? 'unavailable' : hasScan ? 'ready' : 'idle',
      };
    });
    const selected = withActivity.find((item) => item.anonymousId === anonymousId)!;
    let currentIds: Set<string> | undefined;
    if (presentation.filter === 'current') {
      const [host, links] = await Promise.all([
        options.getCurrentHost().catch(() => ''),
        service.siteLinks().catch((error) => { if (isAuthenticationFailure(error)) throw error; return {}; }),
      ]);
      checkDeadline();
      currentIds = new Set(matchHmeAliases(withActivity, host, links, { includeInactive: true }).map(({ email }) => email.anonymousId));
    }
    const visible = selectManagedAddresses(withActivity, {
      search: options.search || '', filter: presentation.filter, sort: presentation.sort, currentIds,
    });
    // A changed active website/filter must not replace the explicitly remembered address.
    return { selected, addresses: visible.some((item) => item.anonymousId === anonymousId) ? visible : [selected] };
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(timeoutError); }, 12_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
