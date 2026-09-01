import React, { Component, ErrorInfo, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import browser from 'webextension-polyfill';

import BrandIcon from '../../components/BrandIcon';
import Symbol from '../../components/Symbol';
import ICloudClient, {
  HmeEmail,
  PremiumMailSettings,
  DEFAULT_SETUP_URL,
  CN_SETUP_URL,
  UnsuccessfulRequestError,
} from '../../iCloudClient';
import {
  ICloudMailClient,
  isICloudMailForwardingAddress,
  type RecentAliasMessage,
} from '../../iCloudMailClient';
import { useBrowserStorageState } from '../../hooks';
import { MessageType, sendMessageToTab } from '../../messages';
import {
  getBrowserStorageValue,
  setBrowserStorageValue,
  Store,
  DEFAULT_STORE,
} from '../../storage';
import { CONTEXT_MENU_ITEM_ID, signedOutCtaCopy } from '../Background/constants';
import { isFirefox } from '../../browserUtils';
import {
  getResolvedLanguage,
  setLanguagePreference,
  tr,
  type LanguagePreference,
} from '../../i18n';
import { PopupState } from './stateMachine';
import './Popup.css';

type View = 'generate' | 'manage' | 'details';
type MailActivityStatus = 'idle' | 'syncing' | 'ready' | 'unavailable' | 'error';
type HmeWithActivity = HmeEmail & {
  lastReceivedAt?: number;
  activityStatus?: MailActivityStatus;
};

const MAIL_ACTIVITY_CACHE_TTL = 24 * 60 * 60 * 1000;
const MAIL_ACTIVITY_SCAN_THREADS = 80;

const cx = (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' ');


const PRIVATE_ALIAS_DOMAINS = new Set([
  'icloud.com',
  'me.com',
  'mac.com',
  'privaterelay.appleid.com',
]);

const COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk',
  'com.au', 'net.au', 'org.au',
  'co.nz', 'co.jp', 'co.kr',
  'com.cn', 'com.hk', 'com.sg',
  'com.br', 'com.mx', 'co.in',
]);

const hostnameFromText = (value: string): string | undefined => {
  const direct = value.includes('://') ? value : `https://${value}`;
  try {
    return new URL(direct).hostname;
  } catch {
    const match = value.match(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z0-9-]{2,63})(?=[:/\s)\]}>,]|$)/i);
    return match?.[1];
  }
};

const normalizeWebsite = (value: string | undefined): { domain: string; url: string } | undefined => {
  const raw = value?.trim();
  if (!raw) return undefined;

  const hostname = hostnameFromText(raw)?.replace(/^www\./i, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || !hostname.includes('.') || PRIVATE_ALIAS_DOMAINS.has(hostname)) return undefined;

  // HME labels are free-form. Values such as "2025.6.30" used to be accepted by URL() as
  // host-like input, which made the icon resolver replace the stable "2" monogram with
  // Chrome's generic globe favicon. A website candidate must have a normal alphabetic TLD
  // and may not be an all-numeric dotted value/IP address.
  const labels = hostname.split('.').filter(Boolean);
  const tld = labels.at(-1) || '';
  if (labels.length < 2 || !/[a-z]/i.test(hostname) || !/^[a-z][a-z0-9-]{1,62}$/i.test(tld)) return undefined;
  if (labels.every((part) => /^\d+$/.test(part))) return undefined;

  return { domain: hostname, url: `https://${hostname}/` };
};

const resolveWebsite = (hme: Pick<HmeEmail, 'domain' | 'label' | 'note'>) =>
  normalizeWebsite(hme.domain) || normalizeWebsite(hme.label) || normalizeWebsite(hme.note);

const faviconDomains = (domain: string): string[] => {
  const parts = domain.split('.').filter(Boolean);
  if (parts.length < 2) return [domain];

  const suffix2 = parts.slice(-2).join('.');
  const minimumLabels = COMMON_SECOND_LEVEL_SUFFIXES.has(suffix2) ? 3 : 2;
  const candidates: string[] = [];
  for (let index = 0; index <= parts.length - minimumLabels; index += 1) {
    const candidate = parts.slice(index).join('.');
    if (!PRIVATE_ALIAS_DOMAINS.has(candidate)) candidates.push(candidate);
  }
  return [...new Set(candidates)];
};

const SITE_ICON_SIZE = 64;
const SITE_ICON_MAX_BYTES = 1024 * 1024;
const GENERIC_FAVICON_PAGE_URL = 'https://apple-all-in-one.invalid/';
const siteIconCache = new Map<string, string | null>();
const siteIconRequests = new Map<string, Promise<string | null>>();

type FaviconAsset = { blob: Blob; bytes: Uint8Array };
let genericFaviconRequest: Promise<FaviconAsset | null> | undefined;

const canDecodeImageBlob = (blob: Blob): Promise<boolean> =>
  new Promise((resolve) => {
    if (!blob.size || blob.size > SITE_ICON_MAX_BYTES) return resolve(false);
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    const finish = (result: boolean) => {
      URL.revokeObjectURL(objectUrl);
      resolve(result);
    };
    image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => finish(false);
    image.src = objectUrl;
  });

const blobToDataUrl = (blob: Blob): Promise<string | null> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });

const faviconApiUrl = (pageUrl: string) => {
  const url = new URL(browser.runtime.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  url.searchParams.set('size', String(SITE_ICON_SIZE));
  return url.toString();
};

const fetchFaviconAsset = async (pageUrl: string): Promise<FaviconAsset | null> => {
  if (isFirefox) return null;
  try {
    const response = await fetch(faviconApiUrl(pageUrl), { cache: 'force-cache' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!(await canDecodeImageBlob(blob))) return null;
    return { blob, bytes: new Uint8Array(await blob.arrayBuffer()) };
  } catch {
    return null;
  }
};

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const genericFavicon = () => {
  genericFaviconRequest ||= fetchFaviconAsset(GENERIC_FAVICON_PAGE_URL);
  return genericFaviconRequest;
};

const resolveSiteIconUrl = async (domain: string): Promise<string | null> => {
  const cacheKey = domain;
  if (siteIconCache.has(cacheKey)) return siteIconCache.get(cacheKey) ?? null;
  const pending = siteIconRequests.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    const domains = faviconDomains(domain);

    // Use Chromium's internal favicon store rather than fetching arbitrary site documents or
    // guessed /favicon.* URLs. That preserves icons hosted on CDN/hashed paths and prevents
    // third-party Link preload headers from being attributed to popup.html as extension errors.
    const generic = await genericFavicon();
    for (const candidateDomain of domains) {
      const asset = await fetchFaviconAsset(`https://${candidateDomain}/`);
      if (!asset || (generic && sameBytes(asset.bytes, generic.bytes))) continue;
      return blobToDataUrl(asset.blob);
    }

    // Chrome returns a generic globe for some unknown pages. Compare it against a guaranteed
    // invalid hostname so unresolved aliases keep their deterministic monogram instead.
    return null;
  })();

  siteIconRequests.set(cacheKey, request);
  try {
    const result = await request;
    siteIconCache.set(cacheKey, result);
    return result;
  } finally {
    siteIconRequests.delete(cacheKey);
  }
};

const SiteIcon = ({
  domain,
  label,
  note,
  large = false,
  inactive = false,
}: {
  domain?: string;
  label?: string;
  note?: string;
  large?: boolean;
  inactive?: boolean;
}) => {
  const site = resolveWebsite({ domain: domain || '', label: label || '', note: note || '' });
  const rootRef = useRef<HTMLSpanElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string>();
  const fallbackSource = (label || site?.domain || note || '').trim().replace(/^www\./i, '');
  const fallbackText = Array.from(fallbackSource).find((char) => /[\p{L}\p{N}]/u.test(char))?.toUpperCase() || '';

  useEffect(() => {
    setResolvedSrc(undefined);
    if (!site) return;
    const node = rootRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    setShouldLoad(false);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: '180px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [site?.domain]);

  useEffect(() => {
    if (!site || !shouldLoad) return;
    let cancelled = false;
    resolveSiteIconUrl(site.domain).then((src) => {
      if (!cancelled && src) setResolvedSrc(src);
    });
    return () => {
      cancelled = true;
    };
  }, [site?.domain, shouldLoad]);

  return (
    <span
      ref={rootRef}
      className={cx('hme-site-icon', large && 'is-large', inactive && 'is-inactive')}
      aria-hidden="true"
      title={site?.domain}
    >
      {resolvedSrc ? (
        <img
          className="hme-site-resolved-image"
          src={resolvedSrc}
          alt=""
          onError={() => {
            siteIconCache.set(site?.domain || '', null);
            setResolvedSrc(undefined);
          }}
        />
      ) : fallbackText ? (
        <span className="hme-site-monogram">{fallbackText}</span>
      ) : (
        <Symbol name={site ? 'globe' : 'mail'} size={large ? 25 : 18} />
      )}
    </span>
  );
};


const getActiveTabForPopup = async () => {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
};

const Spinner = ({ compact = false }: { compact?: boolean }) => (
  <span className={cx('hme-spinner', compact && 'is-compact')} aria-hidden="true" />
);

const ErrorBanner = ({ children }: { children: React.ReactNode }) => (
  <div className="hme-error-banner" role="alert">
    <Symbol name="info" size={17} />
    <span>{children}</span>
  </div>
);

const ToolbarButton = ({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: 'globe' | 'settings' | 'signout';
  onClick: () => void;
}) => (
  <button type="button" className="hme-toolbar-button" aria-label={label} title={label} onClick={onClick}>
    <Symbol name={icon} size={18} />
  </button>
);

const LANGUAGE_OPTIONS: Array<{ value: LanguagePreference; label: () => string }> = [
  { value: 'auto', label: () => tr('Follow Browser', '跟随浏览器') },
  { value: 'zh-CN', label: () => '中文' },
  { value: 'en', label: () => 'English' },
];

const LanguageMenu = () => {
  const [preference, , isLoading] = useBrowserStorageState('languagePreference', DEFAULT_STORE.languagePreference);
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const chooseLanguage = async (next: LanguagePreference) => {
    if (next === preference) {
      setIsOpen(false);
      return;
    }
    await setLanguagePreference(next);
    window.location.reload();
  };

  const label = tr('Language', '语言');
  return (
    <div className="hme-language-control" ref={rootRef}>
      <button
        type="button"
        className={cx('hme-toolbar-button', isOpen && 'is-active')}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        disabled={isLoading}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Symbol name="globe" size={18} />
      </button>
      {isOpen && (
        <div className="hme-language-menu" role="menu" aria-label={label}>
          {LANGUAGE_OPTIONS.map((option) => {
            const selected = preference === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className={cx('hme-language-option', selected && 'is-selected')}
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => void chooseLanguage(option.value)}
              >
                <span>{option.label()}</span>
                {selected && <Symbol name="check" size={15} strokeWidth={2.2} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const Header = ({
  subtitle,
  authenticated = false,
  onSignOut,
}: {
  subtitle?: string;
  authenticated?: boolean;
  onSignOut?: () => void;
}) => (
  <header className="hme-header">
    <div className="hme-brand-lockup">
      <BrandIcon size={34} />
      <div className="hme-brand-copy">
        <h1>Apple All-In-One</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
    </div>
    <div className="hme-toolbar-actions">
      <LanguageMenu />
      <ToolbarButton label={tr('Settings', '设置')} icon="settings" onClick={() => browser.runtime.openOptionsPage()} />
      {authenticated && onSignOut && <ToolbarButton label={tr('Sign out of iCloud', '退出 iCloud')} icon="signout" onClick={onSignOut} />}
    </div>
  </header>
);

const HmeSegmentedControl = ({
  value,
  onChange,
}: {
  value: 'generate' | 'manage';
  onChange: (value: 'generate' | 'manage') => void;
}) => (
  <nav className="hme-segmented" aria-label={tr('Hide My Email sections', '隐藏邮件地址分区')}>
    <button type="button" className={cx(value === 'generate' && 'is-selected')} onClick={() => onChange('generate')}>
      {tr('New Address', '新建地址')}
    </button>
    <button type="button" className={cx(value === 'manage' && 'is-selected')} onClick={() => onChange('manage')}>
      {tr('My Addresses', '我的地址')}
    </button>
  </nav>
);

type AppSection = 'passwords' | 'hide-email';
type PasswordState = 'loading' | 'disconnected' | 'needs_pin' | 'unlocked' | 'no_helper';
type PasswordLogin = { username?: string };
type OtpItem = { username?: string; domain?: string; source?: string };

const AppSegmentedControl = ({ value, onChange }: { value: AppSection; onChange: (value: AppSection) => void }) => (
  <nav className="app-segmented" aria-label={tr('Apple All-In-One sections', 'Apple All-In-One 分区')}>
    <button type="button" className={cx(value === 'passwords' && 'is-selected')} onClick={() => onChange('passwords')}>
      <Symbol name="key" size={15} /> {tr('Passwords', '密码')}
    </button>
    <button type="button" className={cx(value === 'hide-email' && 'is-selected')} onClick={() => onChange('hide-email')}>
      <Symbol name="mail" size={15} /> {tr('Hide My Email', '隐藏邮件地址')}
    </button>
  </nav>
);

const sendPasswordMessage = async <T,>(message: Record<string, unknown>): Promise<T | undefined> => {
  const delays = [0, 100, 250, 500, 900];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    try {
      return (await browser.runtime.sendMessage(message)) as T;
    } catch (error) {
      lastError = error;
      const text = String(error);
      if (!/Receiving end does not exist|message port closed|Could not establish connection/i.test(text)) break;
    }
  }
  console.debug('Password message failed', message.type, lastError);
  return undefined;
};

const PasswordsView = () => {
  const [state, setState] = useState<PasswordState>('loading');
  const [hasChallenge, setHasChallenge] = useState(false);
  const [host, setHost] = useState(tr('This Website', '此网站'));
  const [logins, setLogins] = useState<PasswordLogin[]>([]);
  const [otps, setOtps] = useState<OtpItem[]>([]);
  const [siteItemsLoading, setSiteItemsLoading] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const pinVerifyInFlight = useRef(false);
  const siteLoadSequence = useRef(0);
  const displayedSiteKey = useRef('');

  const loadSiteItems = async () => {
    const sequence = ++siteLoadSequence.current;
    const tab = await getActiveTabForPopup();
    const siteKey = `${tab?.id ?? 'none'}:${tab?.url || ''}`;
    if (displayedSiteKey.current !== siteKey) {
      displayedSiteKey.current = siteKey;
      setLogins([]);
      setOtps([]);
    }
    try {
      if (tab?.url) setHost(new URL(tab.url).hostname);
      else setHost(tr('This Website', '此网站'));
    } catch {
      setHost(tr('This Website', '此网站'));
    }
    setSiteItemsLoading(true);
    setError(undefined);

    try {
      const [loginResult, otpResult] = await Promise.all([
        sendPasswordMessage<{ ok?: boolean; logins?: PasswordLogin[]; error?: string }>({ type: 'getLogins' }),
        sendPasswordMessage<{ ok?: boolean; items?: OtpItem[]; error?: string }>({ type: 'getOtpItems' }),
      ]);
      if (sequence !== siteLoadSequence.current) return;

      const currentTab = await getActiveTabForPopup();
      if (currentTab?.id !== tab?.id || currentTab?.url !== tab?.url) return;

      if (loginResult?.ok) {
        setLogins(loginResult.logins || []);
      } else {
        setError(loginResult?.error || tr(
          'Could not query Apple Passwords. Your saved items were not reported as empty.',
          '无法查询 Apple 密码；扩展不会再把查询失败显示成“没有已保存项目”。'
        ));
      }

      if (otpResult?.ok) {
        setOtps(otpResult.items || []);
      } else if (loginResult?.ok) {
        setError(otpResult?.error || tr(
          'Could not query verification codes.',
          '无法查询验证码。'
        ));
      }
    } finally {
      if (sequence === siteLoadSequence.current) setSiteItemsLoading(false);
    }
  };

  const refreshState = async () => {
    const res = await sendPasswordMessage<{ state?: PasswordState; hasChallenge?: boolean }>({ type: 'getState' });
    const next = res?.state || 'disconnected';
    setState(next);
    setHasChallenge(!!res?.hasChallenge);
    if (next === 'unlocked') await loadSiteItems();
    return { state: next, hasChallenge: !!res?.hasChallenge };
  };

  const requestAccessCode = async (fresh = false) => {
    setBusy('challenge');
    setError(undefined);
    const res = await sendPasswordMessage<{ ok?: boolean; state?: PasswordState; hasChallenge?: boolean; error?: string }>({
      type: 'requestChallenge',
      ifNeeded: !fresh,
    });
    setBusy(undefined);
    if (res?.ok) {
      setState(res.state || 'needs_pin');
      setHasChallenge(res.hasChallenge !== false);
      return true;
    }
    setError(res?.error || tr('Could not request an Apple Passwords code.', '无法请求 Apple 密码验证码。'));
    return false;
  };

  const beginUnlock = async () => {
    setBusy('connect');
    setError(undefined);
    const connected = await sendPasswordMessage<{ ok?: boolean; state?: PasswordState; error?: string }>({ type: 'connect' });
    setBusy(undefined);
    if (!connected?.ok) {
      setError(connected?.error || tr('Could not connect to Apple Passwords.', '无法连接 Apple 密码。'));
      await refreshState();
      return;
    }
    setState(connected.state || 'needs_pin');
    // Starting the native challenge is now tied to this explicit user gesture, never popup mount.
    if ((connected.state || 'needs_pin') === 'needs_pin') await requestAccessCode(false);
    else await refreshState();
  };

  useEffect(() => {
    // Opening the toolbar is itself an explicit user gesture. Restore the convenient behavior
    // from v1.2.4: connect to Apple Passwords and request a challenge automatically on the
    // first popup open, while keeping background getState() a pure read.
    (async () => {
      try {
        const current = await refreshState();
        if (current.state === 'unlocked') return;

        let nextState: PasswordState = current.state;
        let hasLiveChallenge = current.hasChallenge;
        if (nextState === 'disconnected' || nextState === 'no_helper') {
          const connected = await sendPasswordMessage<{ ok?: boolean; state?: PasswordState; error?: string }>({ type: 'connect' });
          if (!connected?.ok) {
            if (connected?.error) setError(connected.error);
            return;
          }
          nextState = connected.state || 'needs_pin';
          setState(nextState);
        }

        if (nextState === 'needs_pin' && !hasLiveChallenge) {
          setBusy('challenge');
          const challenged = await sendPasswordMessage<{ ok?: boolean; state?: PasswordState; hasChallenge?: boolean; error?: string }>({
            type: 'requestChallenge',
            ifNeeded: true,
          });
          setBusy(undefined);
          if (challenged?.ok) {
            setState(challenged.state || 'needs_pin');
            setHasChallenge(challenged.hasChallenge !== false);
          } else if (challenged?.error) {
            setError(challenged.error);
          }
        }
      } catch (e) {
        setBusy(undefined);
        setError(String(e));
      }
    })();
    const listener = (message: unknown) => {
      const msg = message as { type?: string; state?: PasswordState };
      if (msg?.type === 'state' && msg.state) {
        setState(msg.state);
        if (msg.state !== 'needs_pin') setHasChallenge(false);
        if (msg.state === 'unlocked') loadSiteItems().catch(console.debug);
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async (value = pin) => {
    const code = value.replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6 || pinVerifyInFlight.current) return;
    pinVerifyInFlight.current = true;
    setBusy('pin');
    setError(undefined);
    try {
      const res = await sendPasswordMessage<{ ok?: boolean; state?: PasswordState; error?: string; newCode?: boolean }>({ type: 'verifyPin', pin: code });
      setPin('');
      if (res?.ok && res.state === 'unlocked') {
        setState('unlocked');
        setHasChallenge(false);
        await loadSiteItems();
      } else {
        setError(res?.newCode ? `${res?.error || tr('Verification failed', '验证失败')} — ${tr('use the new code shown by macOS.', '请使用 macOS 显示的新验证码。')}` : res?.error || tr('Verification failed.', '验证失败。'));
      }
    } finally {
      pinVerifyInFlight.current = false;
      setBusy(undefined);
    }
  };

  const fillLogin = async (login: PasswordLogin) => {
    setBusy(`login:${login.username || ''}`);
    const res = await sendPasswordMessage<{ ok?: boolean; filled?: boolean; error?: string; reason?: string }>({ type: 'fillOnPage', loginName: { username: login.username || '' } });
    setBusy(undefined);
    if (res?.ok && res.filled) window.close();
    else if (res?.reason === 'no_login_field') {
      setError(tr(
        'No compatible username or password field is visible on this page. Open the sign-in form first, then try again.',
        '当前页面没有可填充的账号或密码输入框。请先打开登录表单，然后重试。'
      ));
    } else setError(res?.error || tr('Could not fill this login.', '无法填充此登录信息。'));
  };

  const fillOtp = async (item: OtpItem) => {
    setBusy(`otp:${item.username || ''}`);
    const res = await sendPasswordMessage<{ ok?: boolean; filled?: boolean; error?: string; reason?: string }>({ type: 'fillOtpOnPage', username: item.username || '' });
    setBusy(undefined);
    if (res?.ok && res.filled) window.close();
    else if (res?.reason === 'no_otp_field') {
      setError(tr(
        'No verification-code field is visible on this page. Open the two-factor step first, then try again.',
        '当前页面没有可填充的验证码输入框。请先进入双重认证步骤，然后重试。'
      ));
    } else setError(res?.error || tr('Could not fill this verification code.', '无法填充此验证码。'));
  };

  if (state === 'loading') {
    return <div className="hme-view-body unified-center compact-state"><Spinner /><h2>{tr('Connecting to Apple Passwords…', '正在连接 Apple 密码…')}</h2><p>{tr('The macOS helper session stays encrypted end to end.', 'macOS 辅助程序会话始终保持端到端加密。')}</p></div>;
  }
  if (state === 'disconnected') {
    return (
      <div className="hme-view-body unified-center password-unlock">
        <span className="unified-hero-icon is-purple"><Symbol name="key" size={29} /></span>
        <h2>{tr('Apple Passwords is locked', 'Apple 密码已锁定')}</h2>
        <p>{tr('Reconnect when you want to use saved passwords or verification codes.', '需要使用已保存密码或验证码时再重新连接。')}</p>
        <button className="hme-primary-button" type="button" onClick={beginUnlock} disabled={busy === 'connect' || busy === 'challenge'}>
          {busy === 'connect' || busy === 'challenge' ? <Spinner compact /> : <><Symbol name="key" size={17} /> {tr('Unlock Apple Passwords', '解锁 Apple 密码')}</>}
        </button>
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </div>
    );
  }
  if (state === 'no_helper') {
    return <div className="unified-center"><span className="unified-hero-icon"><Symbol name="key" size={28} /></span><h2>{tr('Apple helper unavailable', 'Apple 辅助程序不可用')}</h2><p>{tr('Keep this extension’s fixed ID and install the included native policy helper.', '请保持此扩展的固定 ID，并安装随附的原生策略辅助程序。')}</p></div>;
  }
  if (state === 'needs_pin') {
    return (
      <div className="unified-center password-unlock">
        <span className="unified-hero-icon is-purple"><Symbol name="key" size={29} /></span>
        <h2>{tr('Unlock Apple Passwords', '解锁 Apple 密码')}</h2>
        {hasChallenge ? (
          <>
            <p>{tr('Enter the 6-digit code shown by macOS.', '请输入 macOS 显示的 6 位验证码。')}</p>
            <input
              className="unified-pin"
              value={pin}
              onChange={(e) => {
                const nextPin = e.target.value.replace(/\D/g, '').slice(0, 6);
                setPin(nextPin);
                if (nextPin.length === 6) void verify(nextPin);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') void verify(); }}
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              placeholder="••••••"
              autoFocus
            />
            <button className="hme-primary-button" type="button" disabled={busy === 'pin' || pin.length !== 6} onClick={() => void verify()}>{busy === 'pin' ? <Spinner compact /> : tr('Unlock', '解锁')}</button>
            <button className="hme-secondary-action" type="button" disabled={busy === 'challenge'} onClick={async () => { setPin(''); await requestAccessCode(true); }}>{busy === 'challenge' ? <Spinner compact /> : tr('Request New Code', '获取新验证码')}</button>
          </>
        ) : (
          <>
            <p>{tr('Request an access code from macOS when you are ready to unlock Passwords.', '准备好解锁密码时，再让 macOS 显示访问验证码。')}</p>
            <button className="hme-primary-button" type="button" disabled={busy === 'challenge'} onClick={() => requestAccessCode(false)}>
              {busy === 'challenge' ? <Spinner compact /> : <><Symbol name="key" size={17} /> {tr('Show Access Code', '显示访问验证码')}</>}
            </button>
          </>
        )}
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </div>
    );
  }

  return (
    <div className="hme-view-body passwords-view">
      <div className="password-site-heading"><span>{tr('This Website', '此网站')}</span><strong>{host}</strong><button type="button" className="hme-circle-action" onClick={async () => { await sendPasswordMessage({ type: 'clearCache' }); await loadSiteItems(); }}><Symbol name="refresh" size={16} /></button></div>
      {logins.length > 0 && <><div className="hme-section-label">{tr('Saved Passwords', '已保存的密码')}</div><section className="hme-group unified-password-list">{logins.map((login, index) => <button type="button" key={`${login.username}-${index}`} onClick={() => fillLogin(login)} disabled={!!busy}><span className="hme-symbol-tile is-purple"><Symbol name="key" size={17} /></span><span className="unified-row-copy"><strong>{login.username || tr('(no username)', '(无用户名)')}</strong><small>{tr('Fill from Apple Passwords', '从 Apple 密码填充')}</small></span>{busy === `login:${login.username || ''}` ? <Spinner compact /> : <Symbol name="chevron-right" size={15} />}</button>)}</section></>}
      {otps.length > 0 && <><div className="hme-section-label">{tr('Verification Codes', '验证码')}</div><section className="hme-group unified-password-list">{otps.map((item, index) => <button type="button" key={`${item.username}-${index}`} onClick={() => fillOtp(item)} disabled={!!busy}><span className="hme-symbol-tile is-blue"><Symbol name="code" size={17} /></span><span className="unified-row-copy"><strong>{item.username || tr('Verification Code', '验证码')}</strong><small>{item.domain ? `${tr('For', '用于')} ${item.domain}` : tr('Fill current code', '填充当前验证码')}</small></span>{busy === `otp:${item.username || ''}` ? <Spinner compact /> : <Symbol name="chevron-right" size={15} />}</button>)}</section></>}
      {siteItemsLoading && !logins.length && !otps.length && <div className="hme-loading-state"><Spinner /> <span>{tr('Checking Apple Passwords…', '正在查询 Apple 密码…')}</span></div>}
      {!siteItemsLoading && !error && !logins.length && !otps.length && <section className="hme-group unified-empty-group"><span className="hme-symbol-tile is-purple"><Symbol name="key" size={18} /></span><div><strong>{tr('No saved items for this website', '此网站没有已保存项目')}</strong><span>{tr('Click a sign-in field to use the secure inline chooser.', '点击登录输入框即可使用安全的内联选择器。')}</span></div></section>}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <button className="hme-plain-link unified-lock" type="button" onClick={async () => {
        await sendPasswordMessage({ type: 'disconnect' });
        setLogins([]);
        setOtps([]);
        setState('disconnected');
        setHasChallenge(false);
      }}>{tr('Lock Passwords Session', '锁定密码会话')}</button>
    </div>
  );
};

class PopupErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Apple All-In-One popup crashed', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="hme-popup-shell">
        <Header subtitle={tr('Unable to open', '无法打开')} />
        <main className="hme-content">
          <div className="hme-view-body">
            <ErrorBanner>{this.state.error.message || tr('The popup hit an unexpected error.', '弹窗遇到意外错误。')}</ErrorBanner>
            <button type="button" className="hme-primary-button" onClick={() => window.location.reload()}>
              {tr('Reload', '重新载入')}
            </button>
          </div>
        </main>
      </div>
    );
  }
}

const SignInView = ({ error, onRetry }: { error?: string; onRetry?: () => void }) => {
  const userguideUrl = browser.runtime.getURL('userguide.html');

  return (
        <div className="hme-onboarding">
          <div className="hme-onboarding-icon"><BrandIcon size={76} /></div>
          <div className="hme-onboarding-copy">
            <span className="hme-overline">{tr('iCloud+ required', '需要 iCloud+')}</span>
            <h2>{tr('Use Hide My Email in this browser', '在此浏览器中使用隐藏邮件地址')}</h2>
            <p>
              {tr('Sign in to iCloud.com first. Apple All-In-One only reuses the trusted browser session; it never reads or stores your Apple Account password. Passkey, Touch ID and other Apple confirmation remain under your control.', '请先登录 iCloud.com。Apple All-In-One 只会复用浏览器中的可信会话，不会读取或保存你的 Apple 账户密码。通行密钥、Touch ID 和其他 Apple 验证仍由你亲自确认。')}
            </p>
          </div>

          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div className="hme-signin-actions">
            <a className="hme-primary-button hme-link-button" href="https://icloud.com" target="_blank" rel="noreferrer">
              {tr('Open iCloud.com', '打开 iCloud.com')}
              <Symbol name="external" size={16} />
            </a>
            {onRetry && (
              <button type="button" className="hme-secondary-button" onClick={onRetry}>
                <Symbol name="refresh" size={16} />
                {tr('Check Existing Session', '检查现有会话')}
              </button>
            )}
          </div>

          <section className="hme-group hme-onboarding-group">
            <div className="hme-info-row">
              <span className="hme-symbol-tile is-blue"><Symbol name="lock" size={18} /></span>
              <div>
                <strong>{tr('Complete the full sign-in', '完成完整登录')}</strong>
                <span>{tr('Finish two-factor authentication and choose “Trust This Browser”.', '完成双重认证并选择“信任此浏览器”。')}</span>
              </div>
            </div>
            {isFirefox && (
              <div className="hme-info-row">
                <span className="hme-symbol-tile is-purple"><Symbol name="cursor" size={18} /></span>
                <div>
                  <strong>{tr('Firefox Containers', 'Firefox 容器')}</strong>
                  <span>{tr('Sign in to iCloud from a tab outside a container.', '请在容器外的标签页中登录 iCloud。')}</span>
                </div>
              </div>
            )}
          </section>

          <a className="hme-plain-link" href={userguideUrl} target="_blank" rel="noreferrer">{tr('View setup guide', '查看使用指南')}</a>
        </div>
  );
};

const GenerateView = ({ client }: { client: ICloudClient }) => {
  const [hmeEmail, setHmeEmail] = useState<string>();
  const [forwardTo, setForwardTo] = useState<string>();
  const [host, setHost] = useState('');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [reserved, setReserved] = useState<HmeEmail>();
  const [isGenerating, setIsGenerating] = useState(true);
  const [isReserving, setIsReserving] = useState(false);
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const generate = async () => {
    setError(undefined);
    setReserved(undefined);
    setCopied(false);
    setIsGenerating(true);
    try {
      setHmeEmail(await new PremiumMailSettings(client).generateHme());
    } catch (e) {
      setError(String(e));
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      const tab = await getActiveTabForPopup();
      if (tab?.url) {
        try {
          const hostname = new URL(tab.url).hostname;
          setHost(hostname);
          setLabel(hostname);
        } catch {
          setHost('');
        }
      }

      try {
        const list = await new PremiumMailSettings(client).listHme();
        setForwardTo(list.selectedForwardTo);
      } catch (e) {
        setError(String(e));
      }
    };

    bootstrap().catch((e) => setError(String(e)));
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const reserve = async (autofill: boolean) => {
    if (!hmeEmail) return;
    setError(undefined);
    setIsReserving(true);
    try {
      const result = await new PremiumMailSettings(client).reserveHme(
        hmeEmail,
        label || host,
        note || undefined
      );
      setReserved(result);
      if (autofill) {
        try {
          await sendMessageToTab(MessageType.Autofill, result.hme);
        } catch {
          setError(tr('The address was created, but this page could not be autofilled. Copy it instead.', '地址已创建，但无法在此页面自动填充。请改为复制地址。'));
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setIsReserving(false);
    }
  };

  const copy = async () => {
    const value = reserved?.hme || hmeEmail;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  };

  return (
    <div className="hme-view-body">
      <div className="hme-page-intro">
        <span>{tr('For', '用于')}</span>
        <strong>{host || tr('this website', '此网站')}</strong>
      </div>

      <section className="hme-alias-panel">
        <div className="hme-alias-panel-top">
          <span className="hme-symbol-tile is-blue"><Symbol name="mail" size={19} /></span>
          <div className="hme-alias-copy">
            <span>{tr('Hide My Email address', '隐藏邮件地址')}</span>
            <strong title={hmeEmail}>{isGenerating ? tr('Generating…', '正在生成…') : hmeEmail || tr('Unavailable', '不可用')}</strong>
          </div>
          <button
            type="button"
            className="hme-circle-action"
            onClick={generate}
            disabled={isGenerating || isReserving}
            aria-label={tr('Generate another address', '生成另一个地址')}
            title={tr('Generate another address', '生成另一个地址')}
          >
            {isGenerating ? <Spinner compact /> : <Symbol name="refresh" size={17} />}
          </button>
        </div>
        {forwardTo && <div className="hme-alias-panel-footer">{tr('Forward to', '转发至')} <strong>{forwardTo}</strong></div>}
      </section>

      <div className="hme-section-label">{tr('Address Details', '地址详情')}</div>
      <section className="hme-group hme-form-group">
        <label className="hme-form-row">
          <span>{tr('Label', '标签')}</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={host || tr('Website or purpose', '网站或用途')} disabled={!!reserved || isReserving} />
        </label>
        <label className="hme-form-row">
          <span>{tr('Note', '备注')}</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('Optional', '可选')} disabled={!!reserved || isReserving} />
        </label>
      </section>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!reserved ? (
        <div className="hme-actions">
          <button className="hme-primary-button" type="button" disabled={!hmeEmail || !label || isGenerating || isReserving} onClick={() => reserve(true)}>
            {isReserving ? <Spinner compact /> : <Symbol name="autofill" size={18} />}
            {tr('Use Address', '使用地址')}
          </button>
          <button className="hme-secondary-action" type="button" disabled={!hmeEmail || !label || isGenerating || isReserving} onClick={() => reserve(false)}>
            {tr('Create without Autofill', '创建但不自动填充')}
          </button>
        </div>
      ) : (
        <section className="hme-group hme-success-group" role="status">
          <div className="hme-success-row">
            <span className="hme-symbol-tile is-green"><Symbol name="check" size={19} /></span>
            <div className="hme-success-copy">
              <strong>{tr('Address Created', '地址已创建')}</strong>
              <span>{reserved.hme}</span>
            </div>
          </div>
          <div className="hme-success-buttons">
            <button type="button" onClick={copy}><Symbol name={copied ? 'check' : 'copy'} size={16} />{copied ? tr('Copied', '已复制') : tr('Copy', '复制')}</button>
            <button type="button" onClick={() => sendMessageToTab(MessageType.Autofill, reserved.hme).catch(() => setError(tr('This page could not be autofilled. Copy the address and paste it manually.', '无法在此页面自动填充。请复制地址并手动粘贴。')))}>
              <Symbol name="autofill" size={16} />{tr('Autofill', '自动填充')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
};

const formatActivityTime = (timestamp: number, full = false) => {
  const date = new Date(timestamp);
  if (full) return date.toLocaleString(getResolvedLanguage() === 'zh-CN' ? 'zh-CN' : 'en-US');

  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return tr('Just now', '刚刚');
  if (diff < hour) return getResolvedLanguage() === 'zh-CN' ? `${Math.floor(diff / minute)} 分钟前` : `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return getResolvedLanguage() === 'zh-CN' ? `${Math.floor(diff / hour)} 小时前` : `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return getResolvedLanguage() === 'zh-CN' ? `${Math.floor(diff / day)} 天前` : `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(getResolvedLanguage() === 'zh-CN' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
};

const AliasListItem = ({
  hme,
  onClick,
  selectionMode = false,
  selected = false,
}: {
  hme: HmeWithActivity;
  onClick: () => void;
  selectionMode?: boolean;
  selected?: boolean;
}) => {
  const activityLabel = hme.lastReceivedAt
    ? `${tr('Last received', '最后收信')} ${formatActivityTime(hme.lastReceivedAt)}`
    : hme.activityStatus === 'unavailable'
      ? tr('Activity unavailable', '收信活动不可用')
      : hme.activityStatus === 'syncing'
        ? tr('Checking recent mail…', '正在检查近期邮件…')
        : hme.activityStatus === 'error'
          ? tr('Activity refresh failed', '收信活动刷新失败')
          : tr('No recent mail found', '近期未找到邮件');

  return (
    <button
      type="button"
      className={cx('hme-list-row', selectionMode && 'is-selecting', selected && 'is-selected')}
      onClick={onClick}
      aria-pressed={selectionMode ? selected : undefined}
    >
      <SiteIcon domain={hme.domain} label={hme.label} note={hme.note} inactive={!hme.isActive} />
      <span className="hme-list-row-copy">
        <strong>{hme.label || resolveWebsite(hme)?.domain || tr('Untitled Address', '未命名地址')}</strong>
        <span>{hme.hme}</span>
        <small className={cx('hme-activity-line', hme.lastReceivedAt !== undefined ? 'has-activity' : undefined)}>
          <Symbol name="clock" size={11} />
          {activityLabel}
        </small>
      </span>
      <span className={cx('hme-state-dot', hme.isActive && 'is-active')} aria-label={hme.isActive ? tr('Active', '已启用') : tr('Inactive', '已停用')} />
      {selectionMode ? (
        <span className={cx('hme-selection-check', selected && 'is-selected')} aria-hidden="true">
          {selected && <Symbol name="check" size={13} strokeWidth={2.4} />}
        </span>
      ) : (
        <Symbol name="chevron-right" size={15} className="hme-chevron" />
      )}
    </button>
  );
};

const ManageView = ({
  client,
  onSelect,
  refreshKey,
}: {
  client: ICloudClient;
  onSelect: (hme: HmeWithActivity) => void;
  refreshKey: number;
}) => {
  const [emails, setEmails] = useState<HmeEmail[]>();
  const [forwardTo, setForwardTo] = useState<string>();
  const [activity, setActivity] = useState<Record<string, number>>({});
  const [activityStatus, setActivityStatus] = useState<MailActivityStatus>('idle');
  const [activityMessage, setActivityMessage] = useState('');
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState<'deactivate' | 'delete'>();
  const [bulkMessage, setBulkMessage] = useState('');

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setError(undefined);
      try {
        const [result, cachedActivity] = await Promise.all([
          new PremiumMailSettings(client).listHme(),
          getBrowserStorageValue('mailActivityCache'),
        ]);
        setEmails([...result.hmeEmails].sort((a, b) => b.createTimestamp - a.createTimestamp));
        setForwardTo(result.selectedForwardTo);
        if (cachedActivity?.byAlias) setActivity(cachedActivity.byAlias);
      } catch (e) {
        setError(String(e));
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [client, refreshKey]);

  useEffect(() => {
    if (!emails || !forwardTo) return;
    let cancelled = false;

    const syncActivity = async () => {
      if (!isICloudMailForwardingAddress(forwardTo)) {
        setActivityStatus('unavailable');
        setActivityMessage(tr('Mail activity is available when Hide My Email forwards to iCloud Mail.', '只有当隐藏邮件地址转发到 iCloud Mail 时，才能显示收信活动。'));
        return;
      }
      if (!client.dsid || !client.hasWebservice('mccgateway')) {
        setActivityStatus('unavailable');
        setActivityMessage(tr('Refreshing the iCloud web session is required before mail activity can be read.', '需要刷新 iCloud 网页会话后才能读取收信活动。'));
        return;
      }

      const cached = await getBrowserStorageValue('mailActivityCache');
      if (
        activityRefreshKey === 0 &&
        cached?.lastScanAt &&
        Date.now() - cached.lastScanAt < MAIL_ACTIVITY_CACHE_TTL
      ) {
        if (!cancelled) {
          setActivity(cached.byAlias || {});
          setActivityStatus('ready');
          setActivityMessage(
            getResolvedLanguage() === 'zh-CN' ? `活动已同步于 ${formatActivityTime(cached.lastScanAt)} · 已检查 ${cached.scannedThreads || 0} 个近期会话` : `Activity synced ${formatActivityTime(cached.lastScanAt)} · ${cached.scannedThreads || 0} recent threads checked`
          );
        }
        return;
      }

      setActivityStatus('syncing');
      setActivityMessage(tr('Checking recent iCloud Mail activity…', '正在检查近期 iCloud Mail 活动…'));
      try {
        const scan = await new ICloudMailClient(client).scanRecentAliasActivity(
          emails.map((item) => item.hme),
          MAIL_ACTIVITY_SCAN_THREADS
        );
        const previous = cached?.byAlias || {};
        const merged = { ...previous };
        for (const [alias, timestamp] of Object.entries(scan.lastReceivedByAlias)) {
          merged[alias] = Math.max(merged[alias] || 0, timestamp);
        }
        const nextCache = {
          byAlias: merged,
          lastScanAt: scan.scannedAt,
          scannedThreads: scan.scannedThreads,
        };
        await setBrowserStorageValue('mailActivityCache', nextCache);
        if (!cancelled) {
          setActivity(merged);
          setActivityStatus('ready');
          setActivityMessage(
            getResolvedLanguage() === 'zh-CN' ? `刚刚已同步 · 已检查 ${scan.scannedThreads} 个近期会话` : `Activity synced just now · ${scan.scannedThreads} recent threads checked`
          );
        }
      } catch (e) {
        console.debug('iCloud Mail activity scan failed', e);
        if (!cancelled) {
          setActivityStatus('error');
          setActivityMessage(tr('Recent mail activity could not be refreshed. Cached times are still shown.', '无法刷新近期收信活动，仍会显示已缓存的时间。'));
        }
      }
    };

    syncActivity().catch(console.debug);
    return () => {
      cancelled = true;
    };
  }, [activityRefreshKey, client, emails, forwardTo]);

  useEffect(() => {
    if (!emails) return;
    const validIds = new Set(emails.map((item) => item.anonymousId));
    setSelectedIds((previous) => {
      const next = new Set([...previous].filter((id) => validIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [emails]);

  const toggleSelection = (anonymousId: string) => {
    setBulkMessage('');
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(anonymousId)) next.delete(anonymousId);
      else next.add(anonymousId);
      return next;
    });
  };

  const exitSelectionMode = () => {
    if (bulkBusy) return;
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkMessage('');
  };

  const deactivateSelected = async () => {
    if (!emails || !selectedIds.size || bulkBusy) return;
    const targets = emails.filter((item) => selectedIds.has(item.anonymousId) && item.isActive);
    if (!targets.length) {
      setBulkMessage(tr('All selected addresses are already inactive.', '所选地址均已停用。'));
      return;
    }

    setBulkBusy('deactivate');
    setError(undefined);
    setBulkMessage(getResolvedLanguage() === 'zh-CN' ? `正在停用 ${targets.length} 个地址…` : `Deactivating ${targets.length} ${targets.length === 1 ? 'address' : 'addresses'}…`);
    const succeeded = new Set<string>();
    const failed: string[] = [];
    const pms = new PremiumMailSettings(client);

    for (const target of targets) {
      try {
        await pms.deactivateHme(target.anonymousId);
        succeeded.add(target.anonymousId);
      } catch (e) {
        console.debug('Bulk deactivate failed', target.hme, e);
        failed.push(target.hme);
      }
    }

    if (succeeded.size) {
      setEmails((current) => current?.map((item) =>
        succeeded.has(item.anonymousId) ? { ...item, isActive: false } : item
      ));
    }

    setBulkBusy(undefined);
    if (failed.length) {
      setBulkMessage(getResolvedLanguage() === 'zh-CN' ? `已停用 ${succeeded.size} 个；${failed.length} 个失败。失败项仍保持选中。` : `Deactivated ${succeeded.size}; ${failed.length} failed. Failed items remain selected.`);
      setSelectedIds(new Set(emails.filter((item) => failed.includes(item.hme)).map((item) => item.anonymousId)));
    } else {
      setBulkMessage(getResolvedLanguage() === 'zh-CN' ? `已停用 ${succeeded.size} 个地址。` : `Deactivated ${succeeded.size} ${succeeded.size === 1 ? 'address' : 'addresses'}.`);
    }
  };

  const deleteSelected = async () => {
    if (!emails || !selectedIds.size || bulkBusy) return;
    const targets = emails.filter((item) => selectedIds.has(item.anonymousId));
    const confirmed = window.confirm(
      getResolvedLanguage() === 'zh-CN' ? `删除选中的 ${targets.length} 个地址？仍启用的地址会先被停用。此操作无法撤销。` : `Delete ${targets.length} selected ${targets.length === 1 ? 'address' : 'addresses'}? Active addresses will be deactivated first. This cannot be undone.`
    );
    if (!confirmed) return;

    setBulkBusy('delete');
    setError(undefined);
    setBulkMessage(getResolvedLanguage() === 'zh-CN' ? `正在删除 ${targets.length} 个地址…` : `Deleting ${targets.length} ${targets.length === 1 ? 'address' : 'addresses'}…`);
    const deletedIds = new Set<string>();
    const deactivatedIds = new Set<string>();
    const failedIds = new Set<string>();
    const pms = new PremiumMailSettings(client);

    for (const target of targets) {
      try {
        if (target.isActive) {
          await pms.deactivateHme(target.anonymousId);
          deactivatedIds.add(target.anonymousId);
        }
        await pms.deleteHme(target.anonymousId);
        deletedIds.add(target.anonymousId);
      } catch (e) {
        console.debug('Bulk delete failed', target.hme, e);
        failedIds.add(target.anonymousId);
      }
    }

    const deletedAliases = new Set(
      targets.filter((item) => deletedIds.has(item.anonymousId)).map((item) => item.hme)
    );
    if (deletedIds.size || deactivatedIds.size) {
      setEmails((current) => current
        ?.filter((item) => !deletedIds.has(item.anonymousId))
        .map((item) => deactivatedIds.has(item.anonymousId) ? { ...item, isActive: false } : item));
    }
    if (deletedIds.size) {
      setActivity((current) => {
        const next = { ...current };
        deletedAliases.forEach((alias) => delete next[alias]);
        return next;
      });
      const cached = await getBrowserStorageValue('mailActivityCache');
      if (cached?.byAlias) {
        const byAlias = { ...cached.byAlias };
        deletedAliases.forEach((alias) => delete byAlias[alias]);
        await setBrowserStorageValue('mailActivityCache', { ...cached, byAlias });
      }
    }

    setBulkBusy(undefined);
    if (failedIds.size) {
      setSelectedIds(failedIds);
      setBulkMessage(getResolvedLanguage() === 'zh-CN' ? `已删除 ${deletedIds.size} 个；${failedIds.size} 个失败。失败项仍保持选中。` : `Deleted ${deletedIds.size}; ${failedIds.size} failed. Failed items remain selected.`);
    } else {
      setSelectedIds(new Set());
      setSelectionMode(false);
      setBulkMessage('');
    }
  };

  const filtered = useMemo(() => {
    if (!emails) return [];
    const query = search.trim().toLocaleLowerCase();
    const withActivity: HmeWithActivity[] = emails.map((item) => ({
      ...item,
      lastReceivedAt: activity[item.hme],
      activityStatus,
    }));
    if (!query) return withActivity;
    return withActivity.filter((item) =>
      [item.label, item.domain, item.hme, item.note]
        .filter(Boolean)
        .some((value) => value.toLocaleLowerCase().includes(query))
    );
  }, [activity, activityStatus, emails, search]);

  const selectedCount = selectedIds.size;
  const allVisibleSelected = filtered.length > 0 && filtered.every((item) => selectedIds.has(item.anonymousId));

  const toggleSelectAllVisible = () => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allVisibleSelected) filtered.forEach((item) => next.delete(item.anonymousId));
      else filtered.forEach((item) => next.add(item.anonymousId));
      return next;
    });
  };

  return (
    <div className={cx('hme-view-body', selectionMode && 'has-selection')}>
      <div className="hme-manage-heading">
        <div>
          <h2>{tr('My Addresses', '我的地址')}</h2>
          <span>{emails ? getResolvedLanguage() === 'zh-CN' ? `共 ${emails.length} 个` : `${emails.length} total` : tr('Loading…', '正在载入…')}</span>
        </div>
        <div className="hme-manage-actions">
          <button
            type="button"
            className="hme-select-toggle"
            disabled={!!bulkBusy || !emails?.length}
            onClick={() => selectionMode ? exitSelectionMode() : (setSelectionMode(true), setBulkMessage(''))}
          >
            {selectionMode ? tr('Done', '完成') : tr('Select', '选择')}
          </button>
          <button
            type="button"
            className="hme-activity-refresh"
            disabled={selectionMode || activityStatus === 'syncing' || !emails?.length}
            onClick={() => setActivityRefreshKey((value) => value + 1)}
            title={tr('Refresh mail activity', '刷新收信活动')}
            aria-label={tr('Refresh mail activity', '刷新收信活动')}
          >
            {activityStatus === 'syncing' ? <Spinner compact /> : <Symbol name="refresh" size={15} />}
          </button>
        </div>
      </div>

      <div className="hme-search-field">
        <Symbol name="search" size={16} />
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('Search', '搜索')} aria-label={tr('Search addresses', '搜索地址')} />
      </div>

      {activityMessage && (
        <div className={cx('hme-activity-status', activityStatus === 'error' && 'is-error', activityStatus === 'unavailable' && 'is-muted')}>
          <Symbol name="clock" size={13} />
          <span>{activityMessage}</span>
        </div>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {isLoading ? (
        <div className="hme-loading-state"><Spinner /> <span>{tr('Loading addresses…', '正在载入地址…')}</span></div>
      ) : filtered.length ? (
        <section className="hme-group hme-address-list">
          {filtered.map((hme) => (
            <AliasListItem
              key={hme.anonymousId}
              hme={hme}
              selectionMode={selectionMode}
              selected={selectedIds.has(hme.anonymousId)}
              onClick={() => selectionMode ? toggleSelection(hme.anonymousId) : onSelect(hme)}
            />
          ))}
        </section>
      ) : (
        <div className="hme-empty-state">
          <span className="hme-symbol-tile is-gray"><Symbol name="search" size={20} /></span>
          <strong>{search ? tr('No Results', '没有结果') : tr('No Addresses Yet', '暂无地址')}</strong>
          <span>{search ? tr('Try a different search.', '请尝试其他搜索词。') : tr('Create your first private address from New Address.', '从“新建地址”创建你的第一个隐藏邮件地址。')}</span>
        </div>
      )}

      {selectionMode && (
        <div className="hme-bulk-toolbar" role="region" aria-label={tr('Bulk address actions', '批量地址操作')}>
          <div className="hme-bulk-summary">
            <strong>{selectedCount ? getResolvedLanguage() === 'zh-CN' ? `已选择 ${selectedCount} 个` : `${selectedCount} Selected` : tr('Select Addresses', '选择地址')}</strong>
            <button type="button" disabled={!filtered.length || !!bulkBusy} onClick={toggleSelectAllVisible}>
              {allVisibleSelected ? tr('Clear Visible', '清除当前可见选择') : tr('Select Visible', '选择当前可见地址')}
            </button>
          </div>
          {bulkMessage && <div className="hme-bulk-message">{bulkMessage}</div>}
          <div className="hme-bulk-actions">
            <button type="button" className="is-deactivate" disabled={!selectedCount || !!bulkBusy} onClick={deactivateSelected}>
              {bulkBusy === 'deactivate' ? <Spinner compact /> : <Symbol name="pause" size={16} />}
              {tr('Deactivate', '停用')}
            </button>
            <button type="button" className="is-delete" disabled={!selectedCount || !!bulkBusy} onClick={deleteSelected}>
              {bulkBusy === 'delete' ? <Spinner compact /> : <Symbol name="trash" size={16} />}
              {tr('Delete', '删除')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const DetailRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="hme-detail-row"><span>{label}</span><div>{children}</div></div>
);

const DetailsView = ({
  client,
  hme,
  onBack,
  onChanged,
}: {
  client: ICloudClient;
  hme: HmeWithActivity;
  onBack: () => void;
  onChanged: (deleted: boolean, next?: HmeEmail) => void;
}) => {
  const [item, setItem] = useState(hme);
  const [busy, setBusy] = useState<'activation' | 'delete'>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [recentMail, setRecentMail] = useState<RecentAliasMessage[]>();
  const [mailStatus, setMailStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [mailError, setMailError] = useState<string>();
  const [copiedCodeId, setCopiedCodeId] = useState<string>();

  useEffect(() => {
    setItem(hme);
    setRecentMail(undefined);
    setMailStatus('idle');
    setMailError(undefined);
    setCopiedCodeId(undefined);
  }, [hme]);

  const copy = async () => {
    await navigator.clipboard.writeText(item.hme);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  };

  const toggle = async () => {
    setBusy('activation');
    setError(undefined);
    try {
      const pms = new PremiumMailSettings(client);
      if (item.isActive) await pms.deactivateHme(item.anonymousId);
      else await pms.reactivateHme(item.anonymousId);
      const next = { ...item, isActive: !item.isActive };
      setItem(next);
      onChanged(false, next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async () => {
    const confirmed = window.confirm(
      getResolvedLanguage() === 'zh-CN' ? `删除 ${item.hme}？${item.isActive ? ' 系统会先停用此地址。' : ''}此操作无法撤销。` : `Delete ${item.hme}?${item.isActive ? ' It will be deactivated first.' : ''} This cannot be undone.`
    );
    if (!confirmed) return;

    setBusy('delete');
    setError(undefined);
    const pms = new PremiumMailSettings(client);
    let nextItem = item;
    try {
      if (nextItem.isActive) {
        await pms.deactivateHme(nextItem.anonymousId);
        nextItem = { ...nextItem, isActive: false };
        setItem(nextItem);
        onChanged(false, nextItem);
      }
      await pms.deleteHme(nextItem.anonymousId);
      onChanged(true);
    } catch (e) {
      setError(String(e));
      setBusy(undefined);
    }
  };

  const loadRecentMail = async () => {
    setMailError(undefined);
    if (!isICloudMailForwardingAddress(item.forwardToEmail)) {
      setMailStatus('error');
      setMailError(
        tr(
          'Recent mail is available when this address forwards to iCloud Mail.',
          '只有当此地址转发到 iCloud Mail 时，才能读取近期邮件。'
        )
      );
      return;
    }
    if (!client.dsid || !client.hasWebservice('mccgateway')) {
      setMailStatus('error');
      setMailError(
        tr(
          'Refresh the iCloud web session before reading recent mail.',
          '请先刷新 iCloud 网页会话，再读取近期邮件。'
        )
      );
      return;
    }

    setMailStatus('loading');
    try {
      const messages = await new ICloudMailClient(client).listRecentMessagesForAlias(
        item.hme,
        MAIL_ACTIVITY_SCAN_THREADS,
        6
      );
      setRecentMail(messages);
      setMailStatus('ready');
    } catch (e) {
      console.debug('Unable to read recent mail for Hide My Email alias', e);
      setMailStatus('error');
      setMailError(
        tr(
          'Recent mail could not be read. Your address and cached activity were not changed.',
          '无法读取近期邮件，地址与已缓存的收信活动均未被修改。'
        )
      );
    }
  };

  const copyVerificationCode = async (message: RecentAliasMessage) => {
    if (!message.verificationCode) return;
    await navigator.clipboard.writeText(message.verificationCode);
    setCopiedCodeId(message.id);
    window.setTimeout(() => setCopiedCodeId(undefined), 1500);
  };

  return (
    <div className="hme-view-body">
      <button type="button" className="hme-back-button" onClick={onBack}><Symbol name="back" size={16} />{tr('My Addresses', '我的地址')}</button>

      <section className="hme-detail-hero">
        <SiteIcon domain={item.domain} label={item.label} note={item.note} large inactive={!item.isActive} />
        <span className="hme-overline">{tr('Private Address', '隐藏地址')}</span>
        <h2 title={item.hme}>{item.hme}</h2>
        <button type="button" className="hme-pill-button" onClick={copy}><Symbol name={copied ? 'check' : 'copy'} size={15} />{copied ? tr('Copied', '已复制') : tr('Copy', '复制')}</button>
      </section>

      <div className="hme-section-label">{tr('Details', '详情')}</div>
      <section className="hme-group hme-detail-group">
        <DetailRow label={tr('Label', '标签')}><strong>{item.label || '—'}</strong></DetailRow>
        <DetailRow label={tr('Website', '网站')}>
          {resolveWebsite(item) ? (
            <span className="hme-website-value">
              <SiteIcon domain={item.domain} label={item.label} note={item.note} />
              <span>{resolveWebsite(item)?.domain}</span>
            </span>
          ) : (
            <span>—</span>
          )}
        </DetailRow>
        <DetailRow label={tr('Forward To', '转发至')}><span className="hme-blue-text">{item.forwardToEmail}</span></DetailRow>
        <DetailRow label={tr('Created', '创建时间')}><span>{new Date(item.createTimestamp).toLocaleDateString(getResolvedLanguage() === 'zh-CN' ? 'zh-CN' : 'en-US')}</span></DetailRow>
        <DetailRow label={tr('Last Received', '最后收信')}><span>{item.lastReceivedAt
          ? formatActivityTime(item.lastReceivedAt, true)
          : item.activityStatus === 'unavailable'
            ? tr('Unavailable for this forwarding inbox', '此转发邮箱不支持收信活动')
            : item.activityStatus === 'syncing'
              ? tr('Checking recent mail…', '正在检查近期邮件…')
              : item.activityStatus === 'error'
                ? tr('Could not refresh', '无法刷新')
                : tr('Not found in recent scan', '近期扫描中未找到')}</span></DetailRow>
        <DetailRow label={tr('Status', '状态')}><span className={cx('hme-status-text', item.isActive && 'is-active')}><i />{item.isActive ? tr('Active', '已启用') : tr('Inactive', '已停用')}</span></DetailRow>
        {item.note && <DetailRow label={tr('Note', '备注')}><span>{item.note}</span></DetailRow>}
      </section>

      <div className="hme-section-label hme-mail-section-heading">
        <span>{tr('Recent Mail', '近期邮件')}</span>
        {mailStatus !== 'idle' && (
          <button
            type="button"
            disabled={mailStatus === 'loading'}
            onClick={() => void loadRecentMail()}
            aria-label={tr('Refresh recent mail', '刷新近期邮件')}
            title={tr('Refresh recent mail', '刷新近期邮件')}
          >
            {mailStatus === 'loading' ? <Spinner compact /> : <Symbol name="refresh" size={13} />}
          </button>
        )}
      </div>

      {mailStatus === 'idle' && (
        <section className="hme-group hme-mail-consent">
          <span className="hme-symbol-tile is-blue"><Symbol name="mail" size={18} /></span>
          <div>
            <strong>{tr('Check this address’s recent mail', '检查此地址的近期邮件')}</strong>
            <span>{tr('Runs only when you ask. Message previews are not saved by the extension.', '只在你主动操作时读取，扩展不会保存邮件预览。')}</span>
          </div>
          <button type="button" onClick={() => void loadRecentMail()}>{tr('Check', '检查')}</button>
        </section>
      )}

      {mailStatus === 'loading' && (
        <div className="hme-mail-loading" role="status"><Spinner /><span>{tr('Checking recent iCloud Mail…', '正在检查近期 iCloud 邮件…')}</span></div>
      )}

      {mailError && <ErrorBanner>{mailError}</ErrorBanner>}

      {mailStatus === 'ready' && recentMail?.length === 0 && (
        <section className="hme-group hme-mail-empty">
          <Symbol name="mail" size={19} />
          <span>{tr('No recent messages were found for this private address.', '没有找到发给此隐藏地址的近期邮件。')}</span>
        </section>
      )}

      {mailStatus === 'ready' && !!recentMail?.length && (
        <section className="hme-group hme-recent-mail-list">
          {recentMail.map((message) => (
            <article className="hme-mail-row" key={`${message.threadId}:${message.id}`}>
              <div className="hme-mail-row-heading">
                <strong>{message.sender || tr('Unknown Sender', '未知发件人')}</strong>
                <time dateTime={new Date(message.timestamp).toISOString()}>{formatActivityTime(message.timestamp)}</time>
              </div>
              <div className="hme-mail-subject">{message.subject || tr('Message', '邮件')}</div>
              {message.preview && <p>{message.preview}</p>}
              {message.verificationCode && (
                <button type="button" className="hme-code-button" onClick={() => void copyVerificationCode(message)}>
                  <Symbol name={copiedCodeId === message.id ? 'check' : 'copy'} size={14} />
                  <span>{message.verificationCode}</span>
                  <small>{copiedCodeId === message.id ? tr('Copied', '已复制') : tr('Copy Code', '复制验证码')}</small>
                </button>
              )}
            </article>
          ))}
          <a className="hme-mail-open-link" href="https://www.icloud.com/mail/" target="_blank" rel="noreferrer">
            <span>{tr('Open iCloud Mail', '打开 iCloud 邮件')}</span>
            <Symbol name="external" size={14} />
          </a>
        </section>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <div className="hme-section-label">{tr('Actions', '操作')}</div>
      <section className="hme-group hme-action-group">
        <button type="button" disabled={!item.isActive} onClick={() => sendMessageToTab(MessageType.Autofill, item.hme).catch(() => setError(tr('This page could not be autofilled. Copy the address and paste it manually.', '无法在此页面自动填充。请复制地址并手动粘贴。')))}>
          <span className="hme-symbol-tile is-blue"><Symbol name="autofill" size={18} /></span>
          <span>{tr('Autofill on This Page', '在此页面自动填充')}</span>
          <Symbol name="chevron-right" size={15} className="hme-chevron" />
        </button>
        <button type="button" disabled={!!busy} onClick={toggle}>
          <span className="hme-symbol-tile is-orange">{busy === 'activation' ? <Spinner compact /> : <Symbol name={item.isActive ? 'pause' : 'refresh'} size={18} />}</span>
          <span>{item.isActive ? tr('Deactivate Address', '停用地址') : tr('Reactivate Address', '重新启用地址')}</span>
          <Symbol name="chevron-right" size={15} className="hme-chevron" />
        </button>
        <button type="button" className="is-destructive" disabled={!!busy} onClick={remove}>
          <span className="hme-symbol-tile is-red">{busy === 'delete' ? <Spinner compact /> : <Symbol name="trash" size={18} />}</span>
          <span>{item.isActive ? tr('Delete Address…', '删除地址…') : tr('Delete Address', '删除地址')}</span>
        </button>
      </section>
    </div>
  );
};

const constructClient = (clientState: Store['clientState']) => {
  if (!clientState) throw new Error(tr('Cannot construct client without state', '缺少状态，无法创建 iCloud 客户端'));
  return new ICloudClient(clientState.setupUrl, clientState.webservices, clientState.dsid);
};

const performDeauthSideEffects = async () => {
  await browser.contextMenus
    .update(CONTEXT_MENU_ITEM_ID, { title: signedOutCtaCopy(), enabled: true })
    .catch(console.debug);
};

const Popup = () => {
  const [appSection, setAppSection] = useState<AppSection>('passwords');
  const [storedPopupState, setStoredPopupState, isPopupStateLoading] = useBrowserStorageState(
    'popupState',
    PopupState.SignedOut
  );
  const [clientState, setClientState, isClientStateLoading] = useBrowserStorageState(
    'clientState',
    undefined
  );
  const [view, setView] = useState<View>(
    storedPopupState === PopupState.AuthenticatedAndManaging ? 'manage' : 'generate'
  );
  const [selected, setSelected] = useState<HmeWithActivity>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [viewInitialized, setViewInitialized] = useState(false);
  const [isHmeDiscovering, setIsHmeDiscovering] = useState(false);
  const [hmeDiscoveryDone, setHmeDiscoveryDone] = useState(false);
  const [hmeDiscoveryError, setHmeDiscoveryError] = useState<string>();
  const [hmeDiscoveryRetry, setHmeDiscoveryRetry] = useState(0);
  const [autoHmeReconnect] = useBrowserStorageState(
    'autoHmeReconnect',
    DEFAULT_STORE.autoHmeReconnect
  );

  useEffect(() => {
    if (!isPopupStateLoading && !viewInitialized) {
      setView(
        storedPopupState === PopupState.AuthenticatedAndManaging ? 'manage' : 'generate'
      );
      setViewInitialized(true);
    }
  }, [isPopupStateLoading, storedPopupState, viewInitialized]);

  // On a fresh install, the user may already be signed in to iCloud.com. Discover that
  // session only when Hide My Email is explicitly opened; never during install/startup.
  // Do not depend on isHmeDiscovering here: setting that flag from inside this effect would
  // immediately run the cleanup and cancel our own request (the v1.2.1 infinite-check bug).
  useEffect(() => {
    if (
      appSection !== 'hide-email' ||
      isClientStateLoading ||
      clientState ||
      hmeDiscoveryDone ||
      (!autoHmeReconnect && hmeDiscoveryRetry === 0)
    ) return;

    let cancelled = false;
    setIsHmeDiscovering(true);
    setHmeDiscoveryError(undefined);

    const discover = async () => {
      try {
        const attempts = await Promise.all(
          ([DEFAULT_SETUP_URL, CN_SETUP_URL] as const).map(async (setupUrl) => {
            const candidate = new ICloudClient(setupUrl);
            try {
              await candidate.validateToken();
              return { client: candidate, error: undefined as unknown };
            } catch (error) {
              return { client: undefined, error };
            }
          })
        );

        const client = attempts.find((attempt) => attempt.client)?.client;
        const authError = attempts
          .map((attempt) => attempt.error)
          .find(
            (error) =>
              error instanceof UnsuccessfulRequestError &&
              (error.status === 401 || error.status === 403)
          );
        const lastError = authError || attempts.find((attempt) => attempt.error)?.error;

        if (!client) throw lastError || new Error('No trusted iCloud web session was found.');
        if (cancelled) return;

        if (!client.webservices?.premiummailsettings?.url) {
          setStoredPopupState(PopupState.SignedOut);
          setHmeDiscoveryError(
            tr(
              'Your iCloud session does not currently expose Hide My Email. Sign in to iCloud.com and try again.',
              '当前 iCloud 会话没有提供隐藏邮件地址服务。请登录 iCloud.com 后重试。'
            )
          );
          return;
        }

        setClientState({
          setupUrl: client.setupUrl,
          webservices: client.webservices,
          dsid: client.dsid,
        });
        setStoredPopupState(PopupState.Authenticated);
      } catch (error) {
        if (cancelled) return;
        setStoredPopupState(PopupState.SignedOut);
        if (
          error instanceof UnsuccessfulRequestError &&
          (error.status === 401 || error.status === 403)
        ) {
          setHmeDiscoveryError(
            tr(
              'Your iCloud web session has expired. Sign in again to continue using Hide My Email.',
              '你的 iCloud 网页登录状态已失效。请重新登录以继续使用隐藏邮件地址。'
            )
          );
        } else {
          console.debug('Lazy iCloud session discovery failed', error);
          setHmeDiscoveryError(
            tr(
              'Apple All-In-One could not verify an iCloud web session. Sign in to iCloud.com, then try again.',
              'Apple All-In-One 无法验证 iCloud 网页会话。请登录 iCloud.com，然后重试。'
            )
          );
        }
      } finally {
        if (!cancelled) {
          setIsHmeDiscovering(false);
          setHmeDiscoveryDone(true);
        }
      }
    };

    discover().catch(console.debug);
    return () => {
      cancelled = true;
    };
  }, [
    appSection,
    autoHmeReconnect,
    clientState,
    hmeDiscoveryDone,
    hmeDiscoveryRetry,
    isClientStateLoading,
    setClientState,
    setStoredPopupState,
  ]);

  // Hide My Email session validation is deliberately soft. Passwords remains usable even
  // when iCloud.com is signed out or temporarily unreachable.
  useEffect(() => {
    if (appSection !== 'hide-email' || isClientStateLoading || !clientState?.setupUrl) return;

    let cancelled = false;
    const validateCachedSession = async () => {
      try {
        const validationClient = new ICloudClient(clientState.setupUrl);
        await validationClient.validateToken();
        if (cancelled) return;

        if (storedPopupState === PopupState.SignedOut) {
          setStoredPopupState(PopupState.Authenticated);
        }

        if (validationClient.webservices) {
          const previous = JSON.stringify({
            webservices: clientState.webservices || {},
            dsid: clientState.dsid || '',
          });
          const next = JSON.stringify({
            webservices: validationClient.webservices,
            dsid: validationClient.dsid || '',
          });
          if (previous !== next) {
            setClientState({
              setupUrl: clientState.setupUrl,
              webservices: validationClient.webservices,
              dsid: validationClient.dsid,
            });
          }
        }
      } catch (error) {
        if (cancelled) return;
        if (
          error instanceof UnsuccessfulRequestError &&
          (error.status === 401 || error.status === 403)
        ) {
          setHmeDiscoveryError(
            tr(
              'Your iCloud web session expired. Sign in to iCloud.com to reconnect Hide My Email.',
              '你的 iCloud 网页会话已失效。请登录 iCloud.com 以重新连接隐藏邮件地址。'
            )
          );
          setHmeDiscoveryDone(false);
          setStoredPopupState(PopupState.SignedOut);
          setClientState(undefined);
          await performDeauthSideEffects();
        } else {
          console.debug('Soft iCloud session validation failed', error);
        }
      }
    };

    validateCachedSession().catch(console.debug);
    return () => {
      cancelled = true;
    };
  }, [
    appSection,
    clientState?.setupUrl,
    isClientStateLoading,
    setClientState,
    setStoredPopupState,
    storedPopupState,
  ]);

  const navigateHme = (next: 'generate' | 'manage') => {
    setSelected(undefined);
    setView(next);
    setStoredPopupState(
      next === 'manage' ? PopupState.AuthenticatedAndManaging : PopupState.Authenticated
    );
  };

  const signOutHme = async () => {
    if (!clientState) return;
    const client = constructClient(clientState);
    await client.signOut();
    await setBrowserStorageValue('clientState', undefined);
    await performDeauthSideEffects();
    setClientState(undefined);
    setStoredPopupState(PopupState.SignedOut);
    setSelected(undefined);
    setView('generate');
  };

  const hmeLoading = isPopupStateLoading || isClientStateLoading || isHmeDiscovering;
  const hmeClient = clientState ? constructClient(clientState) : undefined;
  const headerSubtitle =
    appSection === 'passwords'
      ? tr('Apple Passwords, codes & passkeys', 'Apple 密码、验证码与通行密钥')
      : view === 'details'
        ? tr('Private address details', '隐藏地址详情')
        : tr('iCloud+ Hide My Email', 'iCloud+ 隐藏邮件地址');

  return (
    <div className="hme-popup-shell unified-shell">
      <Header
        subtitle={headerSubtitle}
        authenticated={appSection === 'hide-email' && !!clientState}
        onSignOut={appSection === 'hide-email' && clientState ? signOutHme : undefined}
      />

      <AppSegmentedControl
        value={appSection}
        onChange={(next) => {
          setAppSection(next);
        }}
      />

      {appSection === 'hide-email' && clientState && view !== 'details' && (
        <HmeSegmentedControl value={view} onChange={navigateHme} />
      )}

      <main className="hme-content unified-content">
        {appSection === 'passwords' && <PasswordsView />}

        {appSection === 'hide-email' && hmeLoading && (
          <div className="hme-view-body unified-center compact-state">
            <Spinner />
            <h2>{tr('Checking iCloud…', '正在检查 iCloud…')}</h2>
            <p>{tr('Password features stay available while Hide My Email reconnects.', '隐藏邮件地址重新连接期间，密码功能仍可继续使用。')}</p>
          </div>
        )}

        {appSection === 'hide-email' && !hmeLoading && !hmeClient && (
          <SignInView
            error={hmeDiscoveryError}
            onRetry={() => {
              setHmeDiscoveryError(undefined);
              setHmeDiscoveryDone(false);
              setHmeDiscoveryRetry((value) => value + 1);
            }}
          />
        )}

        {appSection === 'hide-email' && !hmeLoading && hmeClient && view === 'generate' && (
          <GenerateView client={hmeClient} />
        )}

        {appSection === 'hide-email' && !hmeLoading && hmeClient && view === 'manage' && (
          <ManageView
            client={hmeClient}
            refreshKey={refreshKey}
            onSelect={(hme) => {
              setSelected(hme);
              setView('details');
            }}
          />
        )}

        {appSection === 'hide-email' && !hmeLoading && hmeClient && view === 'details' && selected && (
          <DetailsView
            client={hmeClient}
            hme={selected}
            onBack={() => setView('manage')}
            onChanged={(deleted, next) => {
              setRefreshKey((key) => key + 1);
              if (deleted) {
                setSelected(undefined);
                setView('manage');
              } else if (next) {
                setSelected(next);
              }
            }}
          />
        )}
      </main>
    </div>
  );
};

const SafePopup = () => <PopupErrorBoundary><Popup /></PopupErrorBoundary>;

export default SafePopup;
