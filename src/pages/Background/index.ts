// @ts-ignore -- vendored Open Passwords JavaScript module
import '../../passwords/core/background.js';
import {
  getBrowserStorageValue,
  setBrowserStorageValue,
  Store,
  DEFAULT_STORE,
  Options,
} from '../../storage';
import ICloudClient, {
  type HmeEmail,
  PremiumMailSettings,
  DEFAULT_SETUP_URL,
  CN_SETUP_URL,
} from '../../iCloudClient';
import {
  ActiveInputElementWriteData,
  ActiveInputElementWriteResponse,
  Message,
  MessageType,
  ReservationRequestData,
  sendMessageToTab,
} from '../../messages';
import browser from 'webextension-polyfill';
import {
  CONTEXT_MENU_ITEM_ID,
  loadingCopy,
  notificationMessageCopy,
  notificationTitleCopy,
  signedInCtaCopy,
  signedOutCtaCopy,
} from './constants';
import { initializeI18n, tr } from '../../i18n';

const i18nReady = initializeI18n();

// v1.2.2 briefly used a differently named experimental preference. Migrate the
// boolean locally without contacting Apple or iCloud, then remove the obsolete key.
const migrateReconnectPreference = async () => {
  try {
    const stored = await browser.storage.local.get(['autoHmeReconnect', 'autoICloudSignIn']);
    if (stored.autoHmeReconnect === undefined) {
      await browser.storage.local.set({
        autoHmeReconnect:
          typeof stored.autoICloudSignIn === 'boolean'
            ? stored.autoICloudSignIn
            : DEFAULT_STORE.autoHmeReconnect,
      });
    }
    if (stored.autoICloudSignIn !== undefined) {
      await browser.storage.local.remove('autoICloudSignIn');
    }
  } catch (error) {
    console.debug('Reconnect preference migration skipped', error);
  }
};

migrateReconnectPreference().catch(console.debug);

// Toolbar action recovery lives in background-bootstrap.js so it executes before
// the heavier Passwords/iCloud application bundle and can repair stale tab-scoped state.

const constructClient = async (): Promise<ICloudClient> => {
  const clientState = await getBrowserStorageValue('clientState');
  if (clientState === undefined) {
    console.debug('constructClient: Using default setupUrl');
    return new ICloudClient(DEFAULT_SETUP_URL);
  }
  return new ICloudClient(clientState.setupUrl, clientState.webservices, clientState.dsid);
};

const performDeauthSideEffects = () => {
  setBrowserStorageValue('popupState', DEFAULT_STORE.popupState);
  setBrowserStorageValue('clientState', DEFAULT_STORE.clientState);
  setBrowserStorageValue('mailActivityCache', DEFAULT_STORE.mailActivityCache);
  browser.contextMenus
    .update(CONTEXT_MENU_ITEM_ID, {
      title: signedOutCtaCopy(),
      // Keep the command clickable so an explicit right-click can re-discover an existing
      // trusted iCloud browser session even after cached state was cleared.
      enabled: true,
    })
    .catch(console.debug);
};

const performAuthSideEffects = (
  client: ICloudClient,
  options: { notification?: boolean } = {}
) => {
  const { notification = false } = options;
  setBrowserStorageValue('clientState', {
    setupUrl: client.setupUrl,
    webservices: client.webservices,
    dsid: client.dsid,
  });
  browser.contextMenus
    .update(CONTEXT_MENU_ITEM_ID, {
      title: signedInCtaCopy(),
      enabled: true,
    })
    .catch(console.debug);

  if (notification) {
    browser.notifications
      .create({
        type: 'basic',
        title: notificationTitleCopy(),
        message: notificationMessageCopy(),
        iconUrl: 'icon-128.png',
      })
      .catch(console.debug);
  }
};


// Resolve the browser's trusted iCloud web session for an explicit user action. Prefer the
// cached region first, then probe the normal and China setup endpoints in parallel. This is
// intentionally not run at extension startup, so it cannot reintroduce the old toolbar race.
const sendContextMessage = async (
  tab: browser.Tabs.Tab | undefined,
  frameId: number | undefined,
  data: ActiveInputElementWriteData
): Promise<ActiveInputElementWriteResponse | undefined> => {
  try {
    return (await sendMessageToTab(
      MessageType.ActiveInputElementWrite,
      data,
      tab,
      frameId
    )) as ActiveInputElementWriteResponse | undefined;
  } catch (error) {
    // Existing tabs that predate an extension reload may not have the new HME content
    // script. Re-inject it into the exact frame that opened the context menu and retry.
    if (tab?.id !== undefined && chrome.scripting?.executeScript) {
      try {
        await chrome.scripting.executeScript({
          target: {
            tabId: tab.id,
            ...(frameId === undefined ? {} : { frameIds: [frameId] }),
          },
          files: ['contentScript.bundle.js'],
        });
        return (await sendMessageToTab(
          MessageType.ActiveInputElementWrite,
          data,
          tab,
          frameId
        )) as ActiveInputElementWriteResponse | undefined;
      } catch (retryError) {
        console.debug('Could not reach Hide My Email context target', retryError);
      }
    }
    console.debug('Could not reach Hide My Email context target', error);
    return undefined;
  }
};

const createContextNotification = async (message: string): Promise<void> => {
  await browser.notifications
    .create({
      type: 'basic',
      title: notificationTitleCopy(),
      message,
      iconUrl: 'icon-128.png',
    })
    .catch((error) => console.debug('Could not show Hide My Email notification', error));
};

const sendContextFeedback = async (
  tab: browser.Tabs.Tab | undefined,
  contextFrameId: number,
  status: NonNullable<ActiveInputElementWriteData['status']>,
  message: string
): Promise<boolean> => {
  const feedbackFrames = contextFrameId === 0 ? [0] : [0, contextFrameId];

  for (const frameId of feedbackFrames) {
    const response = await sendContextMessage(tab, frameId, {
      status,
      message,
      fill: false,
      copyToClipboard: false,
    });
    if (response?.ok) return true;
  }

  // Loading notifications would linger after the operation, so reserve the system-level
  // fallback for the terminal result. This guarantees the user sees success/failure even
  // on restricted pages where extension content scripts cannot run.
  if (status !== 'loading') await createContextNotification(message);
  return false;
};

const contextMenuErrorCopy = (error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  return tr(
    `Could not create a private address. ${detail}`,
    `无法创建隐藏邮件地址。${detail}`
  );
};

const resolveTrustedICloudClient = async (): Promise<ICloudClient | undefined> => {
  const cached = await getBrowserStorageValue('clientState');
  const setupUrls: Array<typeof DEFAULT_SETUP_URL | typeof CN_SETUP_URL> = [];
  if (cached?.setupUrl) setupUrls.push(cached.setupUrl);
  for (const setupUrl of [DEFAULT_SETUP_URL, CN_SETUP_URL] as const) {
    if (!setupUrls.includes(setupUrl)) setupUrls.push(setupUrl);
  }

  const attempts = await Promise.all(
    setupUrls.map(async (setupUrl) => {
      const candidate = new ICloudClient(setupUrl);
      try {
        await candidate.validateToken();
        return candidate.webservices?.premiummailsettings?.url ? candidate : undefined;
      } catch {
        return undefined;
      }
    })
  );

  const client = attempts.find((candidate): candidate is ICloudClient => candidate !== undefined);
  if (client) performAuthSideEffects(client);
  return client;
};

const INLINE_ALIAS_CACHE_TTL = 60 * 1000;
let inlineAliasCache:
  | { sessionKey: string; expiresAt: number; emails: HmeEmail[] }
  | undefined;

const candidateHostname = (value: string | undefined): string | undefined => {
  const raw = value?.trim();
  if (!raw || raw.includes('@')) return undefined;
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
      .replace(/^www\./i, '')
      .toLocaleLowerCase();
  } catch {
    return undefined;
  }
};

const aliasesForClient = async (clientState: NonNullable<Store['clientState']>) => {
  const sessionKey = `${clientState.setupUrl}:${clientState.dsid || ''}`;
  if (
    inlineAliasCache?.sessionKey === sessionKey &&
    inlineAliasCache.expiresAt > Date.now()
  ) {
    return inlineAliasCache.emails;
  }

  const client = new ICloudClient(
    clientState.setupUrl,
    clientState.webservices,
    clientState.dsid
  );
  const result = await new PremiumMailSettings(client).listHme();
  inlineAliasCache = {
    sessionKey,
    expiresAt: Date.now() + INLINE_ALIAS_CACHE_TTL,
    emails: result.hmeEmails,
  };
  return result.hmeEmails;
};

const findExistingAliasForHost = (emails: HmeEmail[], host: string): HmeEmail | undefined => {
  const normalizedHost = host.replace(/^www\./i, '').toLocaleLowerCase();
  return [...emails]
    .filter((email) => email.isActive)
    .sort((left, right) => right.createTimestamp - left.createTimestamp)
    .find((email) =>
      [email.domain, email.label, email.note].some((value) => {
        const candidate = candidateHostname(value);
        return !!candidate && (
          candidate === normalizedHost ||
          normalizedHost.endsWith(`.${candidate}`) ||
          candidate.endsWith(`.${normalizedHost}`)
        );
      })
    );
};

// Shared secure Passwords chooser asks for Hide My Email only after a real user click.
// These listeners return synchronously for messages they do not own. This matters because
// an async onMessage listener that resolves undefined can still race another listener's
// response channel in Chromium.
browser.runtime.onMessage.addListener((uncastedMessage: unknown, sender: browser.Runtime.MessageSender) => {
  const message = uncastedMessage as { type?: string; hme?: string; wantAlias?: boolean };
  if (typeof message?.type !== 'string' || !message.type.startsWith('hme:')) return undefined;

  return (async () => {
    if (message.type === 'hme:inline-state') {
      const [clientState, options] = await Promise.all([
        getBrowserStorageValue('clientState'),
        getBrowserStorageValue('iCloudHmeOptions'),
      ]);
      let existingHme: Pick<HmeEmail, 'hme' | 'label' | 'domain'> | undefined;
      if (clientState && message.wantAlias && sender.url) {
        try {
          const senderHost = new URL(sender.url).hostname;
          const existing = findExistingAliasForHost(
            await aliasesForClient(clientState),
            senderHost
          );
          if (existing) {
            existingHme = {
              hme: existing.hme,
              label: existing.label,
              domain: existing.domain,
            };
          }
        } catch (error) {
          console.debug('Could not match a Hide My Email address to this website', error);
        }
      }
      return {
        ok: true,
        ready: !!clientState && options?.autofill.button !== false,
        existingHme,
      };
    }

    const clientState = await getBrowserStorageValue('clientState');
    if (!clientState) return { ok: false, error: tr('Sign in to iCloud.com to use Hide My Email.', '请登录 iCloud.com 以使用隐藏邮件地址。') };
    const client = new ICloudClient(clientState.setupUrl, clientState.webservices, clientState.dsid);

    if (message.type === 'hme:generate') {
      try {
        if (!(await client.isAuthenticated())) {
          performDeauthSideEffects();
          return { ok: false, error: tr('Your iCloud session expired. Sign in to iCloud.com again.', '你的 iCloud 会话已过期，请重新登录 iCloud.com。') };
        }
        const hme = await new PremiumMailSettings(client).generateHme();
        return { ok: true, hme };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }

    if (message.type === 'hme:reserve') {
      try {
        if (!message.hme) return { ok: false, error: tr('No private address was provided.', '未提供隐藏邮件地址。') };
        let label = 'Private Address';
        try {
          if (sender.url) label = new URL(sender.url).hostname || label;
        } catch {}
        const result = await new PremiumMailSettings(client).reserveHme(message.hme, label);
        inlineAliasCache = undefined;
        return { ok: true, hme: result.hme };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }

    if (message.type === 'hme:create-for-site') {
      try {
        if (!(await client.isAuthenticated())) {
          performDeauthSideEffects();
          return { ok: false, error: tr('Your iCloud session expired. Sign in to iCloud.com again.', '你的 iCloud 会话已过期，请重新登录 iCloud.com。') };
        }
        let label = tr('Private Signup', '私密注册');
        try {
          if (sender.url) label = new URL(sender.url).hostname || label;
        } catch {}
        const settings = new PremiumMailSettings(client);
        const generated = await settings.generateHme();
        const result = await settings.reserveHme(generated, label, 'Private signup through Apple All-In-One');
        inlineAliasCache = undefined;
        return { ok: true, hme: result.hme };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }

    return { ok: false, error: tr('Unsupported Hide My Email request.', '不支持的隐藏邮件地址请求。') };
  })();
});

browser.runtime.onMessage.addListener((uncastedMessage: unknown) => {
  const message = uncastedMessage as Message<unknown>;
  if (typeof message?.type !== 'number') return undefined;

  return (async () => {
    switch (message.type) {
      case MessageType.GenerateRequest: {
        const elementId = message.data as string;
        const deauthCallback = async () => {
          await sendMessageToTab(MessageType.GenerateResponse, {
            error: signedOutCtaCopy(),
            elementId,
          });
          performDeauthSideEffects();
        };

        const clientState = await getBrowserStorageValue('clientState');
        if (clientState === undefined) {
          await deauthCallback();
          break;
        }

        const client = new ICloudClient(
          clientState.setupUrl,
          clientState.webservices,
          clientState.dsid
        );
        if (!(await client.isAuthenticated())) {
          await deauthCallback();
          break;
        }

        try {
          const pms = new PremiumMailSettings(client);
          const hme = await pms.generateHme();
          await sendMessageToTab(MessageType.GenerateResponse, { hme, elementId });
        } catch (e) {
          await sendMessageToTab(MessageType.GenerateResponse, {
            error: String(e),
            elementId,
          });
        }
        break;
      }

      case MessageType.ReservationRequest: {
        const { hme, label, elementId } = message.data as ReservationRequestData;
        const client = await constructClient();
        try {
          const pms = new PremiumMailSettings(client);
          await pms.reserveHme(hme, label);
          await sendMessageToTab(MessageType.ReservationResponse, {
            hme,
            elementId,
          });
        } catch (e) {
          await sendMessageToTab(MessageType.ReservationResponse, {
            error: String(e),
            elementId,
          });
        }
        break;
      }

      default:
        break;
    }
    return undefined;
  })();
});

type ContextMenuProperties = Pick<
  browser.Menus.CreateCreatePropertiesType,
  'title' | 'enabled' | 'visible'
>;

const createContextMenu = (menuProperties: ContextMenuProperties): Promise<void> =>
  new Promise((resolve, reject) => {
    try {
      browser.contextMenus.create(
        {
          id: CONTEXT_MENU_ITEM_ID,
          contexts: ['editable'],
          ...menuProperties,
        },
        () => {
          // contextMenus.create reports failures through runtime.lastError instead of throwing.
          // Reading it here prevents Chromium from recording an "Unchecked runtime.lastError".
          const errorMessage = browser.runtime.lastError?.message;
          if (!errorMessage) {
            resolve();
            return;
          }

          // Another lifecycle callback may have created the item after our update attempt.
          // Treat that race as success, but update the winner so its current label/state is kept.
          if (/duplicate id/i.test(errorMessage)) {
            browser.contextMenus
              .update(CONTEXT_MENU_ITEM_ID, menuProperties)
              .then(resolve, reject);
            return;
          }

          reject(new Error(errorMessage));
        }
      );
    } catch (error) {
      reject(error);
    }
  });

const setupContextMenuOnce = async () => {
  await i18nReady;
  const [options, clientState] = await Promise.all([
    getBrowserStorageValue('iCloudHmeOptions'),
    getBrowserStorageValue('clientState'),
  ]);
  const resolvedOptions = options || DEFAULT_STORE.iCloudHmeOptions;

  // Installation must stay lightweight: never validate iCloud or contact the
  // Apple Passwords native helper from onInstalled. Use cached state for the label only.
  // Keep the command enabled even without cached clientState so a right-click can lazily
  // re-discover an already trusted iCloud browser session.
  const menuProperties = {
    title: clientState ? signedInCtaCopy() : signedOutCtaCopy(),
    enabled: true,
    visible: resolvedOptions.autofill.contextMenu,
  };

  try {
    await browser.contextMenus.update(CONTEXT_MENU_ITEM_ID, menuProperties);
  } catch {
    await createContextMenu(menuProperties);
  }
};

let contextMenuSetupRequest: Promise<void> | undefined;
const setupContextMenu = () => {
  contextMenuSetupRequest ||= setupContextMenuOnce().finally(() => {
    contextMenuSetupRequest = undefined;
  });
  return contextMenuSetupRequest;
};

const requestContextMenuSetup = () => {
  setupContextMenu().catch(console.debug);
};

// Also repair the command whenever the service worker starts. This recovers automatically from
// an older bootstrap failure that prevented the onInstalled listener from creating the item.
requestContextMenuSetup();
browser.runtime.onInstalled.addListener(requestContextMenuSetup);

type OptionsStorageChange = {
  [K in keyof browser.Storage.StorageChange]: browser.Storage.StorageChange[K] extends unknown
    ? Options
    : browser.Storage.StorageChange[K];
};

browser.storage.onChanged.addListener((changes: Record<string, browser.Storage.StorageChange>, namespace: string) => {
  const iCloudHmeOptions = changes['iCloudHmeOptions' as keyof Store];
  if (namespace !== 'local' || iCloudHmeOptions === undefined) return;

  const { oldValue, newValue } = iCloudHmeOptions as OptionsStorageChange;
  if (oldValue?.autofill.contextMenu === newValue?.autofill.contextMenu) return;

  browser.contextMenus
    .update(CONTEXT_MENU_ITEM_ID, {
      visible: newValue?.autofill.contextMenu,
    })
    .catch(console.debug);
});

// Popup/session discovery updates clientState asynchronously after installation. Keep the
// context-menu title in sync instead of leaving the install-time "Sign in" label around.
browser.storage.onChanged.addListener((changes, namespace) => {
  if (namespace !== 'local' || !changes.clientState) return;
  const clientState = changes.clientState.newValue as Store['clientState'] | undefined;
  browser.contextMenus
    .update(CONTEXT_MENU_ITEM_ID, {
      title: clientState ? signedInCtaCopy() : signedOutCtaCopy(),
      enabled: true,
    })
    .catch(console.debug);
});


browser.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace !== 'local' || !changes.languagePreference) return;
  await initializeI18n();
  const clientState = await getBrowserStorageValue('clientState');
  browser.contextMenus
    .update(CONTEXT_MENU_ITEM_ID, {
      title: clientState ? signedInCtaCopy() : signedOutCtaCopy(),
      enabled: true,
    })
    .catch(console.debug);
});

const runContextMenuAction = async (
  info: browser.Menus.OnClickData,
  tab?: browser.Tabs.Tab
) => {
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  await sendContextFeedback(tab, frameId, 'loading', loadingCopy());

  const serializedUrl = info.frameUrl || info.pageUrl || tab?.url;
  let hostname = '';
  try {
    hostname = serializedUrl ? new URL(serializedUrl).hostname : '';
  } catch {}

  const client = await resolveTrustedICloudClient();

  if (!client) {
    await sendContextFeedback(tab, frameId, 'error', signedOutCtaCopy());
    performDeauthSideEffects();
    return;
  }

  try {
    const pms = new PremiumMailSettings(client);
    const hme = await pms.generateHme();
    await pms.reserveHme(hme, hostname || tr('Private Address', '隐藏邮件地址'));

    const result = await sendContextMessage(tab, frameId, {
      text: hme,
      fill: true,
      copyToClipboard: true,
    });

    if (result?.filled) {
      await sendContextFeedback(
        tab,
        frameId,
        'success',
        result.copied
          ? tr('Private address created, filled, and copied.', '隐藏邮件地址已创建、填入并复制。')
          : tr('Private address created and filled.', '隐藏邮件地址已创建并填入。')
      );
    } else {
      await sendContextFeedback(
        tab,
        frameId,
        'success',
        result?.copied
          ? tr('Private address created and copied. The original field was no longer available.', '隐藏邮件地址已创建并复制，但原输入框已不可用。')
          : tr('Private address was created, but the original field was no longer available.', '隐藏邮件地址已创建，但原输入框已不可用。')
      );
    }
  } catch (e) {
    await sendContextFeedback(tab, frameId, 'error', contextMenuErrorCopy(e));
  }
};

// contextMenus.onClicked is a void-returning Chrome event. Keep the listener synchronous and
// attach an explicit terminal catch so an unexpected failure can never become a silent no-op.
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ITEM_ID) return;
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  runContextMenuAction(info, tab).catch((error) => {
    sendContextFeedback(tab, frameId, 'error', contextMenuErrorCopy(error)).catch(console.debug);
  });
});

browser.webRequest.onResponseStarted.addListener(
  async (details: browser.WebRequest.OnResponseStartedDetailsType) => {
    await i18nReady;
    const { statusCode, url } = details;
    if (statusCode < 200 || statusCode > 299) {
      console.debug('Request failed', details);
      return;
    }

    const setupUrl = url.split('/accountLogin')[0] as ICloudClient['setupUrl'];
    const client = new ICloudClient(setupUrl);
    if (await client.isAuthenticated()) {
      performAuthSideEffects(client, { notification: true });
    }
  },
  {
    urls: [
      `${DEFAULT_SETUP_URL}/accountLogin*`,
      `${CN_SETUP_URL}/accountLogin*`,
    ],
  },
  []
);

browser.webRequest.onResponseStarted.addListener(
  async (details: browser.WebRequest.OnResponseStartedDetailsType) => {
    await i18nReady;
    const { statusCode } = details;
    if (statusCode < 200 || statusCode > 299) {
      console.debug('Request failed', details);
      return;
    }
    performDeauthSideEffects();
  },
  {
    urls: [`${DEFAULT_SETUP_URL}/logout*`, `${CN_SETUP_URL}/logout*`],
  },
  []
);

browser.runtime.onInstalled.addListener(
  async (details: browser.Runtime.OnInstalledDetailsType) => {
    if (details.reason === 'install') {
      await i18nReady;
      const userguideUrl = browser.runtime.getURL('userguide.html');
      browser.tabs.create({ url: userguideUrl }).then(console.debug);
      browser.notifications
        .create({
          type: 'basic',
          title: notificationTitleCopy(),
          message: tr(
            'Apple All-In-One is installed. Open the toolbar to use Passwords, passkeys, verification codes, and Hide My Email.',
            'Apple All-In-One 已安装。打开工具栏即可使用密码、通行密钥、验证码和隐藏邮件地址。'
          ),
          iconUrl: 'icon-128.png',
        })
        .catch(console.debug);
    }
  }
);
