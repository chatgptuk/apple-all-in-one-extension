import browser from 'webextension-polyfill';
import ICloudClient from './iCloudClient';
import type { LanguagePreference } from './i18n';
import { PopupState } from './pages/Popup/stateMachine';

export type Autofill = {
  button: boolean;
  contextMenu: boolean;
};

export type Options = {
  autofill: Autofill;
};

export type MailActivityCache = {
  byAlias: Record<string, number>;
  lastScanAt?: number;
  scannedThreads?: number;
  lastError?: string;
};

export type Store = {
  popupState: PopupState;
  iCloudHmeOptions: Options;
  clientState?: {
    setupUrl: ConstructorParameters<typeof ICloudClient>[0];
    webservices: ConstructorParameters<typeof ICloudClient>[1];
    dsid?: string;
  };
  mailActivityCache?: MailActivityCache;
  suppressSaveBubble: boolean;
  hidePasskeys: boolean;
  suppressAddressAutofill: boolean;
  languagePreference: LanguagePreference;
  autoHmeReconnect: boolean;
};

export const DEFAULT_STORE: Store = {
  popupState: PopupState.SignedOut,
  iCloudHmeOptions: {
    autofill: {
      button: true,
      contextMenu: true,
    },
  },
  clientState: undefined,
  mailActivityCache: undefined,
  suppressSaveBubble: true,
  hidePasskeys: false,
  suppressAddressAutofill: false,
  languagePreference: 'auto',
  autoHmeReconnect: true,
};

export async function getBrowserStorageValue<K extends keyof Store>(
  key: K
): Promise<Store[K] | undefined> {
  const store: Partial<Store> = await browser.storage.local.get(key);
  return store[key];
}

export async function setBrowserStorageValue<K extends keyof Store>(
  key: K,
  value: Store[K]
): Promise<void> {
  if (value === undefined) {
    await browser.storage.local.remove(key);
  } else {
    await browser.storage.local.set({ [key]: value });
  }
}
