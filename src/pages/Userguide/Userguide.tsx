import React from 'react';
import BrandIcon from '../../components/BrandIcon';
import Symbol, { SymbolName } from '../../components/Symbol';
import { tr } from '../../i18n';
import './Userguide.css';
import '../../styles/apple-design.css';

const SetupStep = ({ number, title, children }: { number: number; title: string; children: React.ReactNode }) => (
  <div className="guide-row">
    <span className="guide-step-number">{number}</span>
    <div className="guide-row-copy">
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  </div>
);

const FeatureRow = ({ icon, tone, title, children }: { icon: SymbolName; tone: string; title: string; children: React.ReactNode }) => (
  <div className="guide-row">
    <span className={`guide-icon is-${tone}`}><Symbol name={icon} size={19} /></span>
    <div className="guide-row-copy">
      <strong>{title}</strong>
      <span>{children}</span>
    </div>
  </div>
);

const Userguide = () => (
  <main className="guide-page">
    <header className="guide-header">
      <BrandIcon size={82} />
      <span className="guide-kicker">{tr('Getting Started', '开始使用')}</span>
      <h1>Apple All-In-One</h1>
      <p>{tr('Use Apple Passwords, verification codes, passkeys and iCloud Hide My Email from one Chromium extension.', '在一个 Chromium 扩展中使用 Apple 密码、验证码、通行密钥和 iCloud 隐藏邮件地址。')}</p>
    </header>

    <section className="guide-section">
      <h2>{tr('Apple Passwords', 'Apple 密码')}</h2>
      <div className="guide-group">
        <SetupStep number={1} title={tr('Keep the fixed extension ID', '保持固定扩展 ID')}>
          {tr('The merged extension keeps the same manifest key as Open Passwords, so the existing macOS native-helper authorization continues to match.', '合并后的扩展继续使用与 Open Passwords 相同的 Manifest Key，因此现有的 macOS 原生辅助程序授权仍然匹配。')}
        </SetupStep>
        <SetupStep number={2} title={tr('Install the native policy helper if needed', '如有需要，安装原生策略辅助程序')}>
          {tr('Run ', '如果此前从未在此浏览器配置 Open Passwords，请运行 ')}<b>native/install.sh</b>{tr(' once if Open Passwords has never been configured on this browser. Fully quit and reopen Chrome afterward.', '。完成后请完全退出并重新打开 Chrome。')}
        </SetupStep>
        <SetupStep number={3} title={tr('Unlock from the Passwords tab', '从“密码”页面解锁')}>
          {tr('Open the toolbar popup, choose Passwords, then enter the 6-digit code shown by macOS.', '打开工具栏弹窗，选择“密码”，然后输入 macOS 显示的 6 位验证码。')}
        </SetupStep>
        <SetupStep number={4} title={tr('Use the secure inline chooser', '使用安全的内联选择器')}>
          {tr('Focus a login, password, new-password or verification-code field. Password values remain inside the isolated extension UI and native messaging flow.', '聚焦登录名、密码、新密码或验证码输入框。密码内容始终留在隔离的扩展界面和原生消息通道中。')}
        </SetupStep>
      </div>
    </section>

    <section className="guide-section">
      <h2>{tr('Hide My Email', '隐藏邮件地址')}</h2>
      <div className="guide-group">
        <SetupStep number={1} title={tr('Sign in to iCloud.com', '登录 iCloud.com')}>
          {tr('Open iCloud.com in a normal browser tab, complete two-factor authentication, and choose ', '在普通浏览器标签页中打开 iCloud.com，完成双重认证，并选择 ')}<b>{tr('Trust This Browser', '信任此浏览器')}</b>。
        </SetupStep>
        <SetupStep number={2} title={tr('Open Hide My Email', '打开“隐藏邮件地址”')}>
          {tr('Switch to the Hide My Email tab in the extension. It reuses the authenticated iCloud browser session and never asks for your Apple Account password.', '切换到扩展中的“隐藏邮件地址”页面。它会复用已认证的 iCloud 浏览器会话，不会要求输入 Apple 账户密码。')}
        </SetupStep>
        <SetupStep number={3} title={tr('Create only when you ask', '仅在你主动操作时创建')}>
          {tr('The normal Hide My Email action generates a candidate only after you click Create and reserves it after Use. Smart Signup is also explicit: choosing Private Signup reuses a matching alias or creates and reserves one while preparing a strong password.', '普通隐藏邮件地址操作只有在点击“创建”后才生成候选地址，并在点击“使用”后正式保留。智能注册同样需要明确操作：选择“私密注册”后，扩展会复用匹配地址，或创建并预留新地址，同时准备强密码。')}
        </SetupStep>
      </div>
    </section>

    <section className="guide-section">
      <h2>{tr('What Is Unified', '统一后的功能')}</h2>
      <div className="guide-group">
        <FeatureRow icon="key" tone="purple" title={tr('Passwords', '密码')}>{tr('Fill and save credentials through the macOS Apple Passwords helper.', '通过 macOS Apple 密码辅助程序填写和保存登录凭据。')}</FeatureRow>
        <FeatureRow icon="code" tone="purple" title={tr('Verification Codes', '验证码')}>{tr('Discover saved Apple Passwords verification codes and fill one only after you choose it.', '发现 Apple 密码中保存的验证码，并且只在你明确选择后填入。')}</FeatureRow>
        <FeatureRow icon="mail" tone="blue" title={tr('Hide My Email', '隐藏邮件地址')}>{tr('Create aliases from the same secure login-field chooser without a second extension popup.', '直接从同一个安全登录框选择器创建隐藏地址，不需要第二个扩展弹窗。')}</FeatureRow>
        <FeatureRow icon="autofill" tone="blue" title={tr('Smart Signup', '智能注册')}>{tr('Detect Sign in with Apple, reuse a site alias, or explicitly create a private address and strong password together.', '识别“使用 Apple 登录”、复用网站地址，或明确地同时创建隐藏地址与强密码。')}</FeatureRow>
        <FeatureRow icon="aliases" tone="cyan" title={tr('Alias Manager', '地址管理')}>{tr('Search, copy, deactivate, reactivate, directly delete, or bulk-manage addresses.', '搜索、复制、停用、重新启用、直接删除或批量管理地址。')}</FeatureRow>
        <FeatureRow icon="clock" tone="green" title={tr('Recent Mail Activity', '近期收信活动')}>{tr('When forwarding to iCloud Mail, show cached last-received activity from a bounded recent Inbox scan.', '转发到 iCloud Mail 时，通过有限范围的近期收件箱扫描显示缓存的最后收信时间。')}</FeatureRow>
        <FeatureRow icon="code" tone="green" title={tr('Recent Mail & Codes', '近期邮件与验证码')}>{tr('Open an address, request a bounded recent-mail scan, and copy a locally detected verification code without storing message previews.', '打开地址后主动执行有限范围的近期邮件扫描，并复制本地识别的验证码，同时不保存邮件预览。')}</FeatureRow>
      </div>
    </section>

    <section className="guide-section">
      <h2>{tr('Security Model', '安全模型')}</h2>
      <div className="guide-group">
        <FeatureRow icon="lock" tone="orange" title={tr('Passwords remain native', '密码保持在原生通道中')}>{tr('Decrypted password data is handled only by the Open Passwords native-session module and is never sent to Hide My Email web services.', '解密后的密码数据只由 Open Passwords 原生会话模块处理，绝不会发送到 Hide My Email Web 服务。')}</FeatureRow>
        <FeatureRow icon="mail" tone="blue" title={tr('Hide My Email remains web-session based', '隐藏邮件地址仍基于网页会话')}>{tr('HME requests use the trusted iCloud.com browser session and do not receive native password-session keys.', 'HME 请求使用受信任的 iCloud.com 浏览器会话，不会获得原生密码会话密钥。')}</FeatureRow>
      </div>
      <p className="guide-footer-copy">{tr('Independent open-source project. Not endorsed by or affiliated with Apple. Open Passwords components retain Apache-2.0 notices; Hide My Email components retain the original MIT notice.', '独立开源项目，与 Apple 无隶属或官方合作关系。Open Passwords 组件保留 Apache-2.0 声明；Hide My Email 组件保留原 MIT 声明。')}</p>
    </section>

    <div className="guide-actions">
      <a className="guide-primary" href="https://icloud.com" target="_blank" rel="noreferrer">{tr('Open iCloud.com', '打开 iCloud.com')} <Symbol name="external" size={15} /></a>
      <a href="https://github.com/chatgptuk/apple-all-in-one-extension" target="_blank" rel="noreferrer">{tr('Project Source', '项目源码')} <Symbol name="external" size={15} /></a>
    </div>
  </main>
);

export default Userguide;
