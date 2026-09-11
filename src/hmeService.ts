import browser from 'webextension-polyfill';
import ICloudClient, {
  UnsuccessfulRequestError,
  type HmeEmail,
  type ListHmeResult,
} from './iCloudClient';
import {
  hmeListCacheKey,
  type HmeListSnapshot,
  type HmeOperationArgs,
} from './hmeRepository';
import type { HmeSiteLinks } from './hme-site-matching';

type ManagerArgs = HmeOperationArgs & {
  'site-links': [];
  'site-links-set': [id: string, hosts: string[]];
};

/** Popup facade; network/cache ownership stays in the background. */
export class ManagedPremiumMailSettings {
  constructor(readonly client: ICloudClient) {}
  private async call<T>(
    ...[operation, ...args]: { [K in keyof ManagerArgs]: [K, ...ManagerArgs[K]] }[keyof ManagerArgs]
  ): Promise<T> {
    const response = (await browser.runtime.sendMessage({
      type: 'hme:manager',
      key: hmeListCacheKey(this.client),
      operation,
      args,
    })) as
      | {
          ok?: boolean;
          result?: unknown;
          status?: number;
          error?: string;
          retryAfterMs?: number;
        }
      | undefined;
    if (!response?.ok) {
      if (response?.status) {
        const error = new UnsuccessfulRequestError(
          response.error || 'iCloud request failed',
          response.status,
          'POST',
          'Hide My Email',
          response.retryAfterMs
        );
        await this.client.reportAuthenticationFailure(error);
        throw error;
      }
      throw new Error(
        response?.error || 'Hide My Email service is unavailable. Please retry.'
      );
    }
    return response.result as T;
  }
  snapshot() {
    return this.call<HmeListSnapshot | undefined>('snapshot');
  }
  listHme(force = false) {
    return this.call<ListHmeResult>('list', force);
  }
  generateHme() {
    return this.call<string>('generate');
  }
  reserveHme(hme: string, label: string, note?: string) {
    // Omit absent notes: Chrome serializes undefined array entries as null.
    if (note === undefined) return this.call<HmeEmail>('reserve', hme, label);
    return this.call<HmeEmail>('reserve', hme, label, note);
  }
  updateHmeMetadata(id: string, label: string, note?: string) {
    if (note === undefined) return this.call<void>('metadata', id, label);
    return this.call<void>('metadata', id, label, note);
  }
  deactivateHme(id: string) {
    return this.call<void>('deactivate', id);
  }
  reactivateHme(id: string) {
    return this.call<void>('reactivate', id);
  }
  deleteHme(id: string) {
    return this.call<void>('delete', id);
  }
  updateForwardToHme(email: string) {
    return this.call<void>('forward', email);
  }
  siteLinks() {
    return this.call<HmeSiteLinks>('site-links');
  }
  setSiteLinks(id: string, hosts: string[]) {
    return this.call<string[]>('site-links-set', id, hosts);
  }
}
