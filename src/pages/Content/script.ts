import browser from 'webextension-polyfill';
import {
  ActiveInputElementWriteData,
  ActiveInputElementWriteResponse,
  Message,
  MessageType,
} from '../../messages';

const EMAIL_INPUT_QUERY =
  'input[type="email"], input[name="email"], input[id="email"], input[autocomplete="email"], input[autocomplete="username"]';

const CONTEXT_TARGET_TTL_MS = 120_000;
const TOAST_DURATION_MS = 2800;

type EditableTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

let lastContextTarget: EditableTarget | undefined;
let lastContextTargetAt = 0;
let toastHost: HTMLDivElement | undefined;
let toastContainer: HTMLDivElement | undefined;
let toastTimer: number | undefined;

const setNativeInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

const setNativeTextareaValue = (input: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

const isWritableInput = (input: HTMLInputElement) => {
  const type = (input.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'file', 'hidden', 'image', 'password', 'radio', 'reset', 'submit'].includes(type) && !input.disabled && !input.readOnly;
};

const isEditableTarget = (value: unknown): value is EditableTarget => {
  if (value instanceof HTMLInputElement) return isWritableInput(value);
  if (value instanceof HTMLTextAreaElement) return !value.disabled && !value.readOnly;
  return value instanceof HTMLElement && value.isContentEditable;
};

const setEditableValue = (target: EditableTarget, value: string) => {
  if (target instanceof HTMLInputElement) {
    setNativeInputValue(target, value);
  } else if (target instanceof HTMLTextAreaElement) {
    setNativeTextareaValue(target, value);
  } else {
    target.focus();
    target.textContent = value;
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  target.focus();
};

const activeEmailInput = () => {
  const el = document.activeElement;
  return el instanceof HTMLInputElement && el.matches(EMAIL_INPUT_QUERY) ? el : undefined;
};

const firstEmailInput = () =>
  document.querySelector<HTMLInputElement>(EMAIL_INPUT_QUERY) || undefined;

const recentContextTarget = () => {
  if (
    lastContextTarget &&
    lastContextTarget.isConnected &&
    Date.now() - lastContextTargetAt <= CONTEXT_TARGET_TTL_MS
  ) {
    return lastContextTarget;
  }
  const active = document.activeElement;
  return isEditableTarget(active) ? active : undefined;
};

const rememberContextTarget = (event: MouseEvent) => {
  const target = event.composedPath().find(isEditableTarget);
  if (!target) return;
  lastContextTarget = target;
  lastContextTargetAt = Date.now();
};

document.addEventListener('contextmenu', rememberContextTarget, true);

const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}

  try {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    helper.style.pointerEvents = 'none';
    (document.body || document.documentElement).appendChild(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    return copied;
  } catch {
    return false;
  }
};

const ensureToast = () => {
  if (toastHost?.isConnected && toastContainer) return toastContainer;

  const host = document.createElement('div');
  host.setAttribute('data-apple-all-in-one-toast', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .toast {
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 2147483647;
      max-width: min(360px, calc(100vw - 36px));
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 14px;
      border: 1px solid rgba(60, 60, 67, .16);
      border-radius: 14px;
      background: rgba(248, 248, 250, .94);
      color: #1d1d1f;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .16);
      backdrop-filter: blur(22px) saturate(180%);
      -webkit-backdrop-filter: blur(22px) saturate(180%);
      font: 500 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
      opacity: 0;
      transform: translateY(-6px) scale(.98);
      transition: opacity .16s ease, transform .16s ease;
      pointer-events: none;
    }
    .toast.visible { opacity: 1; transform: translateY(0) scale(1); }
    .icon {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      font-size: 13px;
      font-weight: 700;
    }
    .loading .icon { color: #007aff; background: rgba(0,122,255,.11); }
    .success .icon { color: #248a3d; background: rgba(52,199,89,.13); }
    .error .icon { color: #d70015; background: rgba(255,59,48,.12); }
    @media (prefers-color-scheme: dark) {
      .toast {
        border-color: rgba(255,255,255,.14);
        background: rgba(35,35,38,.94);
        color: #f5f5f7;
        box-shadow: 0 8px 30px rgba(0,0,0,.35);
      }
    }
  `;
  const container = document.createElement('div');
  container.className = 'toast';
  shadow.append(style, container);
  (document.documentElement || document.body).appendChild(host);
  toastHost = host;
  toastContainer = container;
  return container;
};

const showToast = (status: NonNullable<ActiveInputElementWriteData['status']>, message: string) => {
  const container = ensureToast();
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  const icon = status === 'success' ? '✓' : status === 'error' ? '!' : '…';
  container.className = `toast ${status}`;
  container.replaceChildren();
  const iconNode = document.createElement('span');
  iconNode.className = 'icon';
  iconNode.textContent = icon;
  const copy = document.createElement('span');
  copy.textContent = message;
  container.append(iconNode, copy);
  requestAnimationFrame(() => container.classList.add('visible'));
  if (status !== 'loading') {
    toastTimer = window.setTimeout(() => container.classList.remove('visible'), TOAST_DURATION_MS);
  }
};

export default async function main(): Promise<void> {
  browser.runtime.onMessage.addListener((uncastedMessage: unknown) => {
    const message = uncastedMessage as Message<unknown>;

    switch (message.type) {
      case MessageType.Autofill: {
        const input = activeEmailInput() || firstEmailInput();
        if (input) {
          setNativeInputValue(input, message.data as string);
          input.focus();
        }
        return undefined;
      }
      case MessageType.ActiveInputElementWrite: {
        return (async (): Promise<ActiveInputElementWriteResponse> => {
          const data = (message as Message<ActiveInputElementWriteData>).data;
          if (data.status && data.message) showToast(data.status, data.message);

          let filled = false;
          if (data.fill && data.text) {
            const input = recentContextTarget();
            if (input) {
              setEditableValue(input, data.text);
              filled = true;
            }
          }

          const copied = data.copyToClipboard && data.text
            ? await copyText(data.text)
            : false;

          return { ok: true, filled, copied };
        })();
      }
      default:
        return undefined;
    }
  });
}
