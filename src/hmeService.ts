import browser from 'webextension-polyfill';
import ICloudClient, {
  UnsuccessfulRequestError,
  type HmeEmail,
  type ListHmeResult,
} from './iCloudClient';
import {
  hmeListCacheKey,
  type HmeListSnapshot,
  type HmeOperation,
} from './hmeRepository';

/** Popup facade; network/cache ownership stays in the background. */
export class ManagedPremiumMailSettings {
  constructor(readonly client: ICloudClient) {}
  private async call<T>(
    operation: HmeOperation,
    ...args: unknown[]
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
    return this.call<HmeEmail>('reserve', hme, label, note);
  }
  updateHmeMetadata(id: string, label: string, note?: string) {
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
}
