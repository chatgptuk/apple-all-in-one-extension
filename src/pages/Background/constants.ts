import browser from 'webextension-polyfill';
import { tr } from '../../i18n';

export const CONTEXT_MENU_ITEM_ID = browser.runtime.id.concat(
  '/',
  'hme_generation_and_reservation'
);

export const signedOutCtaCopy = () => tr(
  'Sign in to iCloud to use Hide My Email',
  '登录 iCloud 以使用隐藏邮件地址'
);
export const loadingCopy = () => tr('Hide My Email — Preparing…', '隐藏邮件地址 — 正在准备…');
export const signedInCtaCopy = () => tr('Create Hide My Email Address', '创建隐藏邮件地址');
export const notificationMessageCopy = () => tr(
  'iCloud is connected. Apple All-In-One is ready for Passwords, passkeys, verification codes, and Hide My Email.',
  'iCloud 已连接。Apple All-In-One 已可使用密码、通行密钥、验证码和隐藏邮件地址。'
);
export const notificationTitleCopy = () => 'Apple All-In-One';
