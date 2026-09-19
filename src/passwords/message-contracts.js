/**
 * Shared, runtime-checked boundaries for password messages. These types describe
 * metadata and delivery intent, never authorize a caller or a destination.
 * @typedef {'target_changed'|'no_login_field'|'no_otp_field'|'insecure_page'|'insecure_save'|'locked'|'native_timeout'|'native_busy'|'authorization_cancelled'|'ambiguous_account'|'unavailable'|'invalid_request'} FailureReason
 * @typedef {{suggestions:'automatic'|'manual', privateSignup:boolean, allowHttp:boolean}} SitePreferences
 * @typedef {{type:'fillOnPage',loginName:{username:string},mode?:'fill'|'details'} | {type:'fillOtpOnPage',username:string,mode?:'fill'|'details'}} DetailRequest
 * @typedef {{expectedOrigin:string,expectedHref:string,expectedDocumentToken:string,targetToken:string,documentId?:string}} FillBinding
 * @typedef {{ok:boolean,filled?:boolean,reason?:FailureReason,error?:string}} FillResult
 */
const reasons = new Set(['target_changed', 'no_login_field', 'no_otp_field', 'insecure_page', 'insecure_save', 'locked', 'native_timeout', 'native_busy', 'authorization_cancelled', 'ambiguous_account', 'unavailable', 'invalid_request']);
/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {}; }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 4096) { return typeof value === 'string' && value.length <= max; }
/** @param {unknown} input @returns {SitePreferences} */
export function normalizeSitePreferences(input) {
  const value = record(input);
  return { suggestions: value.suggestions === 'manual' ? 'manual' : 'automatic', privateSignup: value.privateSignup !== false, allowHttp: value.allowHttp !== false };
}
/** @param {unknown} input */
export function validPasswordRequest(input) {
  const m = record(input);
  if (!text(m.type, 64)) return false;
  const modeValid = m.mode === undefined || m.mode === 'fill' || m.mode === 'details';
  switch (m.type) {
    case 'inlineFill': return text(record(m.loginName).username) && text(m.documentToken, 128) && !!m.documentToken;
    case 'inlineFillOtp': return text(m.username) && text(m.documentToken, 128) && !!m.documentToken;
    case 'fillOnPage': return text(record(m.loginName).username) && modeValid;
    case 'fillOtpOnPage': return text(m.username) && modeValid;
    case 'getOtpForLoginDetails': return text(m.username);
    case 'resolveSave': return text(m.username) && text(m.password, 32768) && !!m.password && typeof m.generated === 'boolean' && typeof m.newPwCtx === 'boolean';
    case 'verifyPin': return typeof m.pin === 'string' && /^\d{6}$/.test(m.pin);
    case 'setSitePreferences': {
      const p = record(m.preferences);
      return text(m.host, 253) && !!m.host && (p.suggestions === 'automatic' || p.suggestions === 'manual') && typeof p.privateSignup === 'boolean' && (p.allowHttp === undefined || typeof p.allowHttp === 'boolean');
    }
    case 'inlineLogins': case 'inlineOtpItems': case 'getLogins': case 'getOtpItems':
    case 'getState': case 'connect': case 'requestChallenge': case 'refreshAndRefill':
    case 'clearCache': case 'getSitePreferences': case 'getDiagnostics': return true;
    default: return false;
  }
}

/** Validate message shapes separately from the document/gesture authorization gate.
 * @param {unknown} input
 */
export function validContentFillRequest(input) {
  const m = record(input);
  for (const key of ['expectedOrigin', 'expectedHost', 'expectedHref', 'expectedDocumentToken', 'targetToken']) {
    if (m[key] !== undefined && !text(m[key], key === 'expectedHref' ? 16384 : 2048)) return false;
  }
  if (m.type === 'prepareFill') return true;
  if (!text(m.expectedDocumentToken, 128) || !m.expectedDocumentToken || !text(m.targetToken, 128) || !m.targetToken) return false;
  if (m.type === 'fill') return text(m.username) && text(m.password, 32768) && !!m.password;
  if (m.type === 'fillOtp') return text(m.code, 128) && !!m.code;
  return false;
}
/** @param {unknown} error @returns {FailureReason} */
export function failureReason(error) {
  const e = record(error);
  const code = e.reason || e.code;
  if (typeof code === 'string' && reasons.has(code)) return /** @type {FailureReason} */ (code);
  const message = String(e.message || e.error || error || '');
  if (/ambiguous/i.test(message)) return 'ambiguous_account';
  if (/non-HTTPS|insecure/i.test(message)) return 'insecure_page';
  if (/not unlocked|is locked|needs_pin/i.test(message)) return 'locked';
  if (/session expired|invalid session|session changed|not connected|connection closed|native host has exited/i.test(message)) return 'locked';
  if (/busy|queue/i.test(message)) return 'native_busy';
  if (/timed? ?out|timeout/i.test(message)) return 'native_timeout';
  if (/cancelled|canceled|denied by user/i.test(message)) return 'authorization_cancelled';
  if (/page changed|document changed|original.*field|origin mismatch/i.test(message)) return 'target_changed';
  return 'unavailable';
}
/** @param {FailureReason} reason @param {boolean} [chinese] */
export function failureMessage(reason, chinese = false) {
  const copy = {
    target_changed: ['The sign-in page changed. Select the field again.', '登录页面或输入框已变化，请重新点击要填充的输入框。'],
    no_login_field: ['No compatible sign-in field is visible. If sign-in is embedded, click its field to use the inline chooser. You can also copy from details.', '当前页面没有可填充的登录框。若登录框位于嵌入页面，请点击该框使用网页选择器；也可以在详情中复制。'],
    no_otp_field: ['No verification-code field is visible. Select its field, or copy the code from details.', '未找到验证码输入框，请点击该输入框，或从详情复制验证码。'],
    insecure_page: ['HTTP filling is disabled for this website. Enable it in Website Settings & Status, or use HTTPS.', '已按此网站的设置阻止 HTTP 填充。可在扩展“网站设置与状态”中开启，或使用 HTTPS。'],
    insecure_save: ['Saving passwords from this HTTP page is not supported. Use HTTPS or save in Apple Passwords; the HTTP filling setting is separate.', '此 HTTP 页面不支持保存密码。请使用 HTTPS 页面或在 Apple 密码中保存；这与 HTTP 填充开关无关。'],
    locked: ['Unlock Apple Passwords from the extension toolbar, then retry.', '请从扩展工具栏解锁 Apple 密码后重试。'],
    native_timeout: ['Apple Passwords did not respond in time. Check the system authorization prompt, then retry.', 'Apple 密码响应超时，请检查系统授权窗口后重试。'],
    native_busy: ['Apple Passwords is handling another request. Finish it, then retry.', 'Apple 密码正在处理另一项请求，请先完成该操作再重试。'],
    authorization_cancelled: ['System authorization was not completed. Retry when you are ready.', '系统授权未完成，准备好后可以重试。'],
    ambiguous_account: ['More than one saved item matches this account. Review its website entries in Apple Passwords before filling.', '此账号匹配到多个不同的保存项目，请先在 Apple 密码中确认网站对应的记录。'],
    invalid_request: ['This page is using an older extension interface. Refresh the page and try again.', '当前页面使用的扩展接口已过期或不受支持，请刷新网页后重试。'],
    unavailable: ['The operation could not be completed. Retry, or copy diagnostic information from the extension.', '操作未能完成，请重试，或在扩展中复制诊断信息。'],
  };
  return (copy[reason] || copy.unavailable)[chinese ? 1 : 0];
}

/** @param {unknown} error @returns {FillResult} */
export function failureResult(error) {
  const reason = failureReason(error);
  return { ok: false, filled: false, reason, error: failureMessage(reason) };
}
