import browser from 'webextension-polyfill';

export enum MessageType {
  Autofill,
  GenerateRequest,
  GenerateResponse,
  ReservationRequest,
  ReservationResponse,
  ActiveInputElementWrite,
}

export type Message<T> = {
  type: MessageType;
  data: T;
};

export type ReservationRequestData = {
  hme: string;
  label: string;
  elementId: string;
};

export type GenerationResponseData = {
  hme?: string;
  elementId: string;
  error?: string;
};

export type ActiveInputElementWriteData = {
  text?: string;
  copyToClipboard?: boolean;
  fill?: boolean;
  status?: 'loading' | 'success' | 'error';
  message?: string;
};

export type ActiveInputElementWriteResponse = {
  ok: boolean;
  filled?: boolean;
  copied?: boolean;
};

export type ReservationResponseData = GenerationResponseData;

export const sendMessageToTab = async (
  type: MessageType,
  data: unknown,
  tab?: browser.Tabs.Tab,
  frameId?: number
): Promise<unknown> => {
  if (tab === undefined) {
    // Popup code should target the tab in the window that owns the popup.
    // Service-worker callers may not have a current window, so fall back to
    // the last focused Chrome window in that case.
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab === undefined) {
      [tab] = await browser.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
    }
  }

  if (tab?.id !== undefined) {
    return browser.tabs.sendMessage(
      tab.id,
      { type, data },
      frameId === undefined ? undefined : { frameId }
    );
  }
  return undefined;
};
