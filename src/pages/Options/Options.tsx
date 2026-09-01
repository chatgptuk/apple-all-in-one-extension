import React, { useEffect, useState } from 'react';

import BrandIcon from '../../components/BrandIcon';
import Symbol from '../../components/Symbol';
import { useBrowserStorageState } from '../../hooks';
import ICloudClient, { PremiumMailSettings } from '../../iCloudClient';
import { LanguagePreference, setLanguagePreference, tr } from '../../i18n';
import { DEFAULT_STORE } from '../../storage';
import './Options.css';

const SIGNED_OUT_COPY = () => tr(
  'Sign in to iCloud.com from the Hide My Email tab before changing the forwarding address.',
  '请先在“隐藏邮件地址”页面登录 iCloud.com，然后再更改转发地址。'
);
const cx = (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' ');

type IconTone = 'blue' | 'purple' | 'orange' | 'green' | 'gray';

const Toggle = ({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) => (
  <button type="button" className={cx('hme-switch', checked && 'is-on')} role="switch" aria-checked={checked} aria-label={label} onClick={onChange}>
    <span />
  </button>
);

const SettingsRow = ({
  icon,
  tone = 'blue',
  title,
  description,
  trailing,
  href,
}: {
  icon: React.ReactNode;
  tone?: IconTone;
  title: string;
  description?: string;
  trailing?: React.ReactNode;
  href?: string;
}) => {
  const content = (
    <>
      <span className={`settings-icon is-${tone}`}>{icon}</span>
      <span className="settings-row-copy">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </span>
      {trailing && <span className="settings-row-trailing">{trailing}</span>}
      {href && <Symbol name="chevron-right" size={16} className="settings-chevron" />}
    </>
  );

  return href ? (
    <a className="settings-row" href={href} target="_blank" rel="noreferrer">{content}</a>
  ) : (
    <div className="settings-row">{content}</div>
  );
};

const SettingsSection = ({ title, footer, children }: { title: string; footer?: string; children: React.ReactNode }) => (
  <section className="settings-section">
    <h2>{title}</h2>
    <div className="settings-group">{children}</div>
    {footer && <p className="settings-footer-copy">{footer}</p>}
  </section>
);

type PrivacySetting = { set?: (details: { value: boolean }, callback?: () => void) => void; clear?: (details: Record<string, never>, callback?: () => void) => void };

const clearPrivacyPref = (pref: PrivacySetting | undefined) => {
  try { pref?.clear?.({}, () => void chrome.runtime.lastError); } catch (_) {}
};

const setPrivacyPrefFalse = (pref: PrivacySetting | undefined) => {
  try { pref?.set?.({ value: false }, () => void chrome.runtime.lastError); } catch (_) {}
};

const LanguageSettings = () => {
  const [preference] = useBrowserStorageState('languagePreference', DEFAULT_STORE.languagePreference);

  const change = async (next: LanguagePreference) => {
    await setLanguagePreference(next);
    window.location.reload();
  };

  return (
    <SettingsRow
      icon={<Symbol name="globe" size={18} />}
      tone="blue"
      title={tr('Language', '语言')}
      description={tr('Follow the browser language by default, or choose a language for this extension.', '默认跟随浏览器语言，也可以单独为此扩展指定语言。')}
      trailing={(
        <select
          className="settings-language-select"
          value={preference || 'auto'}
          onChange={(e) => change(e.target.value as LanguagePreference)}
          aria-label={tr('Language', '语言')}
        >
          <option value="auto">{tr('Follow Browser', '跟随浏览器')}</option>
          <option value="zh-CN">中文</option>
          <option value="en">English</option>
        </select>
      )}
    />
  );
};

const PasswordSettings = () => {
  const [suppressSaveBubble, setSuppressSaveBubble] = useBrowserStorageState('suppressSaveBubble', true);
  const [hidePasskeys, setHidePasskeys] = useBrowserStorageState('hidePasskeys', false);
  const [suppressAddressAutofill, setSuppressAddressAutofill] = useBrowserStorageState('suppressAddressAutofill', false);

  const toggleSaveBubble = () => {
    const next = !suppressSaveBubble;
    setSuppressSaveBubble(next);
    const pref = chrome.privacy?.services?.passwordSavingEnabled;
    if (next) setPrivacyPrefFalse(pref as PrivacySetting | undefined);
    else clearPrivacyPref(pref as PrivacySetting | undefined);
  };

  const toggleAddressAutofill = () => {
    const next = !suppressAddressAutofill;
    setSuppressAddressAutofill(next);
    const pref = chrome.privacy?.services?.autofillAddressEnabled;
    if (next) setPrivacyPrefFalse(pref as PrivacySetting | undefined);
    else clearPrivacyPref(pref as PrivacySetting | undefined);
  };

  return (
    <>
      <SettingsRow
        icon={<Symbol name="key" size={18} />}
        tone="purple"
        title={tr('Prefer Apple Passwords', '优先使用 Apple 密码')}
        description={tr("Disable Chrome's own password-save bubble while this extension manages password saves.", '由此扩展管理密码保存时，关闭 Chrome 自带的保存密码提示。')}
        trailing={<Toggle checked={suppressSaveBubble} onChange={toggleSaveBubble} label={tr('Prefer Apple Passwords', '优先使用 Apple 密码')} />}
      />
      <SettingsRow
        icon={<Symbol name="lock" size={18} />}
        tone="purple"
        title={tr('Hide Conditional Passkey Autofill', '隐藏条件式通行密钥自动填充')}
        description={tr('Suppress silent conditional passkey suggestions; explicit passkey sign-in still works.', '隐藏静默出现的通行密钥建议；手动选择通行密钥登录仍可正常使用。')}
        trailing={<Toggle checked={hidePasskeys} onChange={() => setHidePasskeys(!hidePasskeys)} label={tr('Hide conditional passkey autofill', '隐藏条件式通行密钥自动填充')} />}
      />
      <SettingsRow
        icon={<Symbol name="autofill" size={18} />}
        tone="gray"
        title={tr('Disable Chrome Address Autofill', '关闭 Chrome 地址自动填充')}
        description={tr('Optional. Leave off if you still want Chrome to fill saved names and postal addresses.', '可选。如果仍希望 Chrome 填写姓名和邮寄地址，请保持关闭。')}
        trailing={<Toggle checked={suppressAddressAutofill} onChange={toggleAddressAutofill} label={tr('Disable Chrome address autofill', '关闭 Chrome 地址自动填充')} />}
      />
    </>
  );
};

const HmeAutofillSettings = () => {
  const [options, setOptions] = useBrowserStorageState('iCloudHmeOptions', DEFAULT_STORE.iCloudHmeOptions);
  const [autoHmeReconnect, setAutoHmeReconnect] = useBrowserStorageState('autoHmeReconnect', DEFAULT_STORE.autoHmeReconnect);
  const toggle = (key: keyof typeof options.autofill) => setOptions({
    ...options,
    autofill: { ...options.autofill, [key]: !options.autofill[key] },
  });

  return (
    <>
      <SettingsRow
        icon={<Symbol name="mail" size={18} />}
        tone="blue"
        title={tr('Hide My Email in Login Fields', '在登录框中使用隐藏邮件地址')}
        description={tr('Add a Create action to the secure Passwords chooser. It never generates an alias until you click Create.', '在安全的密码选择器中加入“创建”操作。只有你主动点击“创建”后才会生成新地址。')}
        trailing={<Toggle checked={options.autofill.button} onChange={() => toggle('button')} label={tr('Hide My Email in login fields', '在登录框中使用隐藏邮件地址')} />}
      />
      <SettingsRow
        icon={<Symbol name="cursor" size={18} />}
        tone="blue"
        title={tr('Right-Click Shortcut', '右键快捷操作')}
        description={tr('Add a Hide My Email action to editable-field context menus.', '在可编辑输入框的右键菜单中加入“隐藏邮件地址”操作。')}
        trailing={<Toggle checked={options.autofill.contextMenu} onChange={() => toggle('contextMenu')} label={tr('Right-click shortcut', '右键快捷操作')} />}
      />
      <SettingsRow
        icon={<Symbol name="refresh" size={18} />}
        tone="blue"
        title={tr('Automatically Reconnect Hide My Email', '自动重新连接隐藏邮件地址')}
        description={tr(
          'On by default. When Hide My Email loses its cached session, automatically re-check the trusted iCloud web session already present in this browser. This never reads your Apple Account password and cannot bypass Passkey, Touch ID, two-factor authentication, or other Apple confirmation.',
          '默认开启。隐藏邮件地址的缓存会话失效时，自动重新检查此浏览器中已有的可信 iCloud 网页会话。此功能不会读取你的 Apple 账户密码，也不会绕过通行密钥、Touch ID、双重认证或 Apple 的其他确认。'
        )}
        trailing={<Toggle checked={autoHmeReconnect} onChange={() => setAutoHmeReconnect(!autoHmeReconnect)} label={tr('Automatically reconnect Hide My Email', '自动重新连接隐藏邮件地址')} />}
      />
    </>
  );
};

const ForwardingSettings = () => {
  const [clientState, , isClientStateLoading] = useBrowserStorageState('clientState', undefined);
  const [emails, setEmails] = useState<string[]>();
  const [selected, setSelected] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (isClientStateLoading) return;
    const load = async () => {
      setLoading(true);
      setError(undefined);
      if (!clientState?.setupUrl) {
        setError(SIGNED_OUT_COPY());
        setLoading(false);
        return;
      }

      const client = new ICloudClient(clientState.setupUrl, clientState.webservices, clientState.dsid);
      if (!(await client.isAuthenticated())) {
        setError(SIGNED_OUT_COPY());
        setLoading(false);
        return;
      }

      try {
        const result = await new PremiumMailSettings(client).listHme();
        setEmails(result.forwardToEmails);
        setSelected(result.selectedForwardTo);
        setSaved(result.selectedForwardTo);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    };
    load().catch((e) => setError(String(e)));
  }, [clientState?.setupUrl, clientState?.dsid, isClientStateLoading]);

  const save = async () => {
    if (!clientState || !selected) return;
    setSaving(true);
    setError(undefined);
    try {
      const client = new ICloudClient(clientState.setupUrl, clientState.webservices, clientState.dsid);
      await new PremiumMailSettings(client).updateForwardToHme(selected);
      setSaved(selected);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="settings-inline-state"><span className="settings-spinner" />{tr('Loading iCloud settings…', '正在载入 iCloud 设置…')}</div>;
  if (error) return <div className="settings-inline-state is-error"><Symbol name="info" size={17} />{error}</div>;

  return (
    <div className="settings-forward-row">
      <span className="settings-icon is-green"><Symbol name="forward" size={18} /></span>
      <span className="settings-row-copy">
        <strong>{tr('Hide My Email Forwarding', '隐藏邮件地址转发')}</strong>
        <span>{tr('Choose which verified inbox receives messages from private aliases.', '选择用于接收隐藏邮件地址来信的已验证邮箱。')}</span>
      </span>
      <div className="settings-forward-control">
        <select value={selected} onChange={(e) => setSelected(e.target.value)} disabled={saving} aria-label={tr('Forward aliases to', '转发至')}>
          {emails?.map((email) => <option key={email} value={email}>{email}</option>)}
        </select>
        <button type="button" onClick={save} disabled={saving || !selected || selected === saved}>
          {saving ? tr('Saving…', '正在保存…') : selected === saved ? tr('Saved', '已保存') : tr('Save', '保存')}
        </button>
      </div>
    </div>
  );
};

const Options = () => (
  <div className="settings-page">
    <main className="settings-window">
      <header className="settings-header">
        <BrandIcon size={62} />
        <div>
          <span className="settings-kicker">{tr('Preferences', '偏好设置')}</span>
          <h1>Apple All-In-One</h1>
          <p>{tr('Configure Apple Passwords integration and iCloud Hide My Email from one extension.', '在一个扩展中管理 Apple 密码、通行密钥、验证码与 iCloud 隐藏邮件地址。')}</p>
        </div>
      </header>

      <SettingsSection title={tr('General', '通用')}>
        <LanguageSettings />
      </SettingsSection>

      <SettingsSection title={tr('Apple Passwords', 'Apple 密码')} footer={tr('Password reads still require the macOS Apple Passwords helper and its encrypted native session.', '读取密码仍需要 macOS 的 Apple 密码辅助程序及其加密的原生会话。')}>
        <PasswordSettings />
      </SettingsSection>

      <SettingsSection title={tr('Hide My Email', '隐藏邮件地址')}>
        <HmeAutofillSettings />
      </SettingsSection>

      <SettingsSection title={tr('Forwarding', '转发')} footer={tr('Forwarding destinations are managed by iCloud and must already be verified on your Apple Account.', '转发目标由 iCloud 管理，并且必须已在你的 Apple 账户中完成验证。')}>
        <ForwardingSettings />
      </SettingsSection>

      <SettingsSection title={tr('Security & Privacy', '安全与隐私')}>
        <SettingsRow
          icon={<Symbol name="lock" size={18} />}
          tone="orange"
          title={tr('Separate Security Boundaries', '独立的安全边界')}
          description={tr('Passwords stay in the native encrypted Passwords session. Hide My Email only reuses the trusted iCloud.com browser session already present in this browser. Automatic reconnect re-checks that web session; it never reads, stores, or submits your Apple Account password.', '密码始终留在原生加密的密码会话中；隐藏邮件地址只会复用此浏览器中已有的可信 iCloud.com 网页会话。自动重新连接只会重新检查该网页会话，绝不会读取、保存或提交你的 Apple 账户密码。')}
        />
      </SettingsSection>

      <SettingsSection title={tr('Project', '项目')}>
        <SettingsRow
          icon={<Symbol name="external" size={18} />}
          tone="blue"
          title="Apple All-In-One"
          description={tr('Project repository, releases, issues and source code.', '项目仓库、发布版本、问题反馈与源代码。')}
          href="https://github.com/chatgptuk/apple-all-in-one-extension"
        />
      </SettingsSection>

      <SettingsSection title={tr('Upstream Projects', '主要上游项目')} footer={tr('Independent open-source project. Not endorsed by or affiliated with Apple. Open Passwords components retain Apache-2.0 notices; Hide My Email components retain the original MIT notice.', '独立开源项目，与 Apple 无隶属或官方合作关系。Open Passwords 组件保留 Apache-2.0 声明；Hide My Email 组件保留原 MIT 声明。')}>
        <SettingsRow icon={<Symbol name="key" size={18} />} tone="purple" title="Open Passwords" description={tr('Apple Passwords, verification codes and secure field chooser.', 'Apple 密码、验证码与安全输入框选择器。')} href="https://github.com/ManiForoughi2/open-passwords" />
        <SettingsRow icon={<Symbol name="mail" size={18} />} tone="blue" title="Hide My Email" description={tr('Private alias creation, management and recent iCloud Mail activity.', '隐藏邮件地址的创建、管理与近期 iCloud Mail 活动。')} href="https://github.com/dedoussis/icloud-hide-my-email-browser-extension" />
        <SettingsRow icon={<Symbol name="external" size={18} />} tone="gray" title={tr('Open iCloud.com', '打开 iCloud.com')} href="https://icloud.com" />
      </SettingsSection>
    </main>
  </div>
);

export default Options;
