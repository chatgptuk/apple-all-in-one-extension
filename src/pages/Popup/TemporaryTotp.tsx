import React, { useEffect, useRef, useState } from 'react';
import Symbol from '../../components/Symbol';
import { tr } from '../../i18n';
import { createTemporaryTotpSession, type TemporaryTotpState } from './temporary-totp-session';
import './TemporaryTotp.css';

const TemporaryTotpForm = () => {
  const [input, setInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [state, setState] = useState<TemporaryTotpState>({ status: 'empty' });
  const session = useRef<ReturnType<typeof createTemporaryTotpSession> | undefined>(undefined);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const active = createTemporaryTotpSession(setState);
    session.current = active;
    return () => { active.dispose(); session.current = undefined; };
  }, []);
  const change = (text: string) => {
    setInput(text);
    void session.current?.setInput(text);
  };
  const error = state.error === 'invalid_key'
    ? tr('Enter the complete Base32 setup key (at least 16 characters: A–Z, 2–7). Spaces are OK.', '请输入完整的 Base32 设置密钥（至少 16 位，由 A–Z、2–7 组成，可带空格）。')
    : state.error === 'unsupported_uri' || state.error === 'unsupported_options'
      ? tr('This setup link is not supported. Use a TOTP link with SHA1, SHA256 or SHA512, 6–8 digits and a 1–300 second period.', '暂不支持此设置链接。请使用 SHA1、SHA256 或 SHA512、6–8 位、1–300 秒周期的 TOTP 链接。')
      : tr('Could not generate a code. Clear the key and try again.', '暂时无法生成验证码，请清空密钥后重试。');
  return (
    <div className="temporary-totp-body" id="temporary-totp-content">
      <label htmlFor="temporary-totp-key">{tr('Setup key', '设置密钥')} <span>{tr('2FA', 'Setup key')}</span></label>
      <div className="temporary-totp-input">
        <input ref={field} id="temporary-totp-key" type={revealed ? 'text' : 'password'} value={input}
          onChange={(event) => change(event.target.value)} placeholder={tr('Paste your 2FA setup key', '粘贴 2FA 设置密钥')}
          autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={4096} autoFocus
          aria-invalid={state.status === 'error'} aria-describedby={state.status === 'error' ? 'temporary-totp-error' : 'temporary-totp-privacy'} />
        <button type="button" aria-label={revealed ? tr('Hide setup key', '隐藏设置密钥') : tr('Show setup key', '显示设置密钥')}
          aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>{revealed ? tr('Hide', '隐藏') : tr('Show', '显示')}</button>
      </div>
      <div className="temporary-totp-result">
        <span className="temporary-totp-caption">{tr('Current code', '当前验证码')}</span>
        <output aria-label={tr('Current verification code', '当前动态验证码')} aria-live="polite" aria-atomic="true">
          {state.code ? state.code.replace(new RegExp(`(.{${state.code.length === 8 ? 4 : 3}})(?=.)`, 'g'), '$1 ') : '••• •••'}
        </output>
        <div className="temporary-totp-time">
          <progress max={state.period || 30} value={state.seconds || 0} aria-label={tr('Time remaining', '剩余时间')} />
          <span>{state.status === 'ready' ? `${state.seconds}${tr('s until refresh', ' 秒后刷新')}` : state.status === 'loading' ? tr('Generating…', '正在生成…') : tr('Updates automatically', '自动更新验证码')}</span>
        </div>
      </div>
      {state.status === 'error' && <p id="temporary-totp-error" className="temporary-totp-error" role="alert">{error}</p>}
      <div className="temporary-totp-actions">
        <button type="button" className="hme-secondary-action" disabled={!input} onClick={() => { change(''); setRevealed(false); field.current?.focus(); }}>{tr('Clear', '清空')}</button>
        <button type="button" className="hme-primary-button" disabled={state.status !== 'ready'}
          onClick={() => void session.current?.copy((code) => navigator.clipboard.writeText(code))}>
          <Symbol name="copy" size={15} />{state.copyNotice === 'copied' ? tr('Copied', '已复制') : tr('Copy Code', '复制验证码')}
        </button>
      </div>
      {state.copyNotice === 'failed' && <p role="status" className="temporary-totp-error">{tr('Could not copy. Select and copy the code above.', '复制失败，请选中上方验证码手动复制。')}</p>}
      <p id="temporary-totp-privacy" className="temporary-totp-privacy">{tr('Calculated here. Never saved or uploaded. Cleared when you collapse this tool, leave Passwords or close the popup.', '仅在此处计算，不保存、不上传。收起工具、离开密码页或关闭弹窗即清除。')}</p>
    </div>
  );
};

export default function TemporaryTotp() {
  const [open, setOpen] = useState(false);
  return (
    <section className="temporary-totp" aria-label={tr('Temporary 2FA', '临时 2FA')}>
      <button type="button" className="temporary-totp-toggle" aria-expanded={open} aria-controls={open ? 'temporary-totp-content' : undefined} onClick={() => setOpen(!open)}>
        <span className="temporary-totp-icon"><Symbol name="code" size={19} /></span>
        <span><strong>{tr('Temporary 2FA', '临时 2FA')}</strong><small>{tr('Get a code from a setup key', '输入设置密钥，查看动态验证码')}</small></span>
        <Symbol name="chevron-right" size={15} className={open ? 'is-expanded' : ''} />
      </button>
      {open && <TemporaryTotpForm />}
    </section>
  );
}
