(() => {
const CONTENT_BUILD_ID = chrome.runtime.getManifest().version;
if (globalThis.__APPLE_ALL_IN_ONE_PASSWORDS_CONTENT_BUILD__ === CONTENT_BUILD_ID) return;
globalThis.__APPLE_ALL_IN_ONE_PASSWORDS_CONTENT_BUILD__ = CONTENT_BUILD_ID;

// Secure inline UI for Open Passwords.
// Sensitive UI lives in a chrome-extension:// iframe inside a CLOSED shadow root.
// The page can see only the inert host element; usernames/PIN/generated passwords never live in page DOM.
console.log('[Apple All-In-One] secure content UI loaded');

let appLanguagePreference = 'auto';
function appResolvedLanguage() {
  if (appLanguagePreference === 'zh-CN') return 'zh-CN';
  if (appLanguagePreference === 'en') return 'en';
  let ui = 'en';
  try { ui = chrome.i18n?.getUILanguage?.() || navigator.language || 'en'; } catch (_) { ui = navigator.language || 'en'; }
  return /^zh(?:-|$)/i.test(ui) ? 'zh-CN' : 'en';
}
function L(en, zh) { return appResolvedLanguage() === 'zh-CN' ? zh : en; }
try {
  chrome.storage?.local?.get({ languagePreference: 'auto' }, (d) => { appLanguagePreference = d.languagePreference || 'auto'; });
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.languagePreference) appLanguagePreference = changes.languagePreference.newValue || 'auto';
  });
} catch (_) {}

const OTP_AUTOCOMPLETE = /one-time-code/i;
const OTP_HINT = /\b(otp|one[\s-]?time(?:[\s-]?(?:password|passcode|code))?|verification(?:[\s-]?code)?|2fa|mfa|two[\s-]?factor(?:[\s-]?authentication)?(?:[\s-]?code)?|auth(?:entication)?[\s-]?code|authenticator(?:[\s-]?app)?(?:[\s-]?code)?|sms[\s-]?code|security[\s-]?code|passcode|token(?:[\s-]?code)?)\b/i;
const NONLOGIN_HINT = /\b(search|find|filter|query|lookup|tag|tags|mention|comment|reply|message|chat|post|caption|note|subject|topic|recipient|address|street|city|state|zip|postal|country|first[\s-]?name|last[\s-]?name|full[\s-]?name|company|title|url|website|coupon|promo|voucher|gift[\s-]?card|amount|quantity|qty|price|card[\s-]?number|cvv|cvc|expiry|account[\s-]?(?:number|no|holder)|routing|iban|invoice|order|tracking|keyword)\b/i;
const LOGINISH = /log[\s_-]?in|sign[\s_-]?in|auth|session|sso|oauth|account|idp|passport/i;
const SUBMITY_LABEL = /\b(sign[\s-]?in|sign[\s-]?up|log[\s-]?in|register|create[\s-]?account|save|update|reset|confirm|done|set|apply|activate|enroll|finish|proceed|verify|join|change[\s-]?password|continue|next|submit)\b/i;
const SUBMITY_ATTR = /pwd|passw|reset|submit|login|signin|confirm|continue|next|done|save|set|apply/i;
const SIGNUP_LABEL = /\b(sign[\s-]?up|register|create[\s-]?(?:an?\s+)?account|join|get[\s-]?started)\b|注册|创建账号|建立帐户|建立帳戶|加入/i;
const APPLE_SIGN_IN_LABEL = /\b(?:sign[\s-]?(?:in|up)|log[\s-]?in|continue)\s+with\s+apple\b|使用\s*Apple\s*(?:登录|登入|繼續|继续)|通过\s*Apple\s*(?:登录|登入)|用\s*Apple\s*(?:登录|登入)/i;
const APPLE_SIGN_IN_ATTR = /sign.?in.?with.?apple|apple.?sign.?in|apple.?login|appleid.?auth/i;
const IFRAME_LOGIN_ALLOWLIST = [
  'accounts.google.com', 'adyen.com', 'affirm.com', 'afterpay.com', 'amazon.com', 'amazoncognito.com',
  'appleid.apple.com', 'atlassian.com', 'auth0.com', 'authkit.app', 'awsapps.com', 'b2clogin.com',
  'beyondidentity.com', 'cash.app', 'ciamlogin.com', 'clearpay.co.uk', 'clerk.accounts.dev', 'clerk.com',
  'corbado.io', 'cyberark.cloud', 'delinea.app', 'descope.com', 'descope.io', 'discord.com',
  'dropbox.com', 'duosecurity.com', 'dynamicauth.com', 'facebook.com', 'finicity.com', 'force.com',
  'forgeblocks.com', 'forgerock.com', 'forgerock.io', 'frontegg.com', 'fusionauth.io', 'github.com',
  'gitlab.com', 'hanko.io', 'idaptive.app', 'jumpcloud.com', 'kakao.com', 'kinde.com', 'klarna.com',
  'line.me', 'link.com', 'linkedin.com', 'live.com', 'loginradius.com', 'magic.link',
  'microsoftonline.com', 'mojoauth.com', 'moneydesktop.com', 'naver.com', 'okta-emea.com', 'okta.com',
  'oktapreview.com', 'onelogin.com', 'openlogin.com', 'ory.sh', 'oryapis.com', 'paypal.com',
  'phasetwo.io', 'ping-eng.com', 'pingidentity.com', 'pingone.com', 'plaid.com', 'privy.io',
  'propelauth.com', 'propelauthtest.com', 'razorpay.com', 'reddit.com', 'sailpoint.com', 'salesforce.com',
  'secureauth.com', 'securid.com', 'shop.app', 'shopify.com', 'slack.com', 'spotify.com', 'stripe.com',
  'stytch.com', 'supertokens.com', 'tink.com', 'transmitsecurity.io', 'truelayer.com', 'twitch.tv',
  'twitter.com', 'userfront.com', 'venmo.com', 'verify.ibm.com', 'vk.com', 'web3auth.io', 'workos.com',
  'x.com', 'xecurify.com', 'yahoo.com', 'yandex.com', 'yandex.ru', 'zitadel.cloud',
];

const UI_URL = chrome.runtime.getURL('src/inline.html');
const EXT_ORIGIN = (UI_URL.match(/^chrome-extension:\/\/[^/]+/) || [chrome.runtime.getURL('').replace(/\/$/, '')])[0];
const UI_MIN_WIDTH = 300;
const UI_MAX_WIDTH = 420;
const UI_DEFAULT_HEIGHT = 170;
const UI_MAX_HEIGHT = 430;
const UI_GAP = 6;
const USER_GESTURE_WINDOW_MS = 1200;

const everPassword = new WeakSet();
let fillAnchor = null;
let lastAutofill = null;
let lastGenerated = null;
let lastSaveKey = '';
let lastSaveAt = 0;
let lastGesture = { at: 0, kind: '', target: null };
let offerSeq = 0;
let aliasLookupSeq = 0;

let uiHost = null;
let uiShadow = null;
let uiFrame = null;
let uiPort = null;
let uiAnchor = null;
let uiExpectedRect = null;
let uiState = null;
let uiSecret = null;
let uiAuthenticated = false;
let uiAuthTimer = null;
let uiLoadCount = 0;
let extensionContextInvalidated = false;

function isExtensionContextError(error) {
  return /Extension context invalidated/i.test(String(error?.message ?? error ?? ''));
}

function stopInvalidatedContentScript() {
  if (extensionContextInvalidated) return;
  extensionContextInvalidated = true;
  offerSeq += 1;
  aliasLookupSeq += 1;
  try { closeUi(); } catch {}
}

async function sendRuntimeMessage(message) {
  if (extensionContextInvalidated) return null;
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isExtensionContextError(error)) {
      stopInvalidatedContentScript();
      return null;
    }
    throw error;
  }
}

function attrBlob(el) {
  let labelText = '';
  try {
    if (el.labels?.length) labelText = Array.from(el.labels, (l) => l.textContent).join(' ');
    const lb = el.getAttribute('aria-labelledby');
    if (lb) labelText += ' ' + lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
  } catch {}
  return [el.name, el.id, el.getAttribute('aria-label'), el.placeholder, el.getAttribute('autocomplete'), labelText]
    .filter(Boolean)
    .join(' ');
}

function isOtpField(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  const ac = el.getAttribute('autocomplete') || '';
  if (OTP_AUTOCOMPLETE.test(ac)) return true;

  const blob = attrBlob(el);
  if (OTP_HINT.test(blob)) return true;

  // A large number of government/bank 2FA pages omit autocomplete=one-time-code.
  // Recognize the common 4–8 digit numeric-code shape without treating arbitrary
  // numeric inputs (postal codes, quantities, phone numbers) as OTP fields.
  const max = parseInt(el.getAttribute('maxlength') || '0', 10);
  const min = parseInt(el.getAttribute('minlength') || '0', 10);
  const pattern = el.getAttribute('pattern') || '';
  const type = String(el.type || 'text').toLowerCase();
  const numericish =
    el.inputMode === 'numeric' ||
    el.inputMode === 'decimal' ||
    type === 'tel' ||
    /\\d|0-9|\[0-9\]/i.test(pattern);
  const codeish = /\b(code|authenticator|verification|verify|token|two[\s-]?factor|2fa|mfa)\b/i.test(blob);

  if (numericish && max === 1) return true; // split OTP boxes
  if (numericish && max >= 4 && max <= 8 && codeish) return true;
  if (numericish && min >= 4 && min <= 8 && max >= min && max <= 8 && codeish) return true;
  return false;
}

function isHideEmailField(el) {
  // Keep Hide My Email UI off iCloud itself so the Passwords chooser can work there
  // without the merged privacy action overlapping Apple's own account flows.
  const host = String(location.hostname || '').toLowerCase();
  if (host === 'icloud.com' || host.endsWith('.icloud.com') || host === 'icloud.com.cn' || host.endsWith('.icloud.com.cn')) return false;
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return false;
  const type = String(el.type || 'text').toLowerCase();
  if (type === 'password' || type === 'hidden') return false;
  const ac = String(el.autocomplete || '').toLowerCase();
  const hints = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''}`.toLowerCase();
  return type === 'email' || ac === 'email' || ac === 'username' || /(^|\b)(email|e-mail|username|user|login)(\b|$)/i.test(hints);
}

function isPasswordField(el) {
  return el instanceof HTMLInputElement && el.type === 'password';
}

function isPasswordish(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (el.type === 'password' || everPassword.has(el)) return true;
  const t = (el.type || 'text').toLowerCase();
  if (!['text', ''].includes(t)) return false;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  return ac.includes('password') || /passw|pwd/i.test(attrBlob(el));
}

function isSearchOrComboField(el) {
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'searchbox' || role === 'combobox') return true;
  if ((el.type || '').toLowerCase() === 'search') return true;
  if ((el.getAttribute('enterkeyhint') || '').toLowerCase() === 'search') return true;
  const aac = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
  return aac === 'list' || aac === 'both' || aac === 'inline';
}

function hasStrongIdentitySignal(el) {
  const t = (el.type || 'text').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (ac.includes('username') || ac.includes('email') || ac.includes('webauthn')) return true;
  if (t === 'email') return true;
  return /\b(e[\s-]?mail|sign[\s-]?in[\s-]?id|log[\s-]?in[\s-]?id|user[\s-]?id|username|passkey)\b/i.test(attrBlob(el));
}

function isUsernameField(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (isOtpField(el) || isSearchOrComboField(el)) return false;
  const t = (el.type || 'text').toLowerCase();
  if (!['text', 'email', 'tel', ''].includes(t)) return false;
  if (hasStrongIdentitySignal(el)) return true;
  const blob = attrBlob(el);
  if (NONLOGIN_HINT.test(blob)) return false;
  return /\b(user|login|signin|sign[\s-]?in|loginid)\b/i.test(blob);
}

function isVisible(el) {
  if (!el?.isConnected) return false;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') < 0.1) return false;
  if (el.offsetParent === null && s.position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width >= 4 && r.height >= 4;
}

function isFillable(el) {
  if (!el?.isConnected) return false;
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
  if (el.offsetParent === null && s.position !== 'fixed') return true;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  if (parseFloat(s.opacity || '1') < 0.1) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) {
    if (r.left < -1000 || r.top < -1000 || r.left > vw + 5000) return false;
  }
  return true;
}

function pageHasVisiblePassword(field) {
  if (Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible)) return true;
  const root = field?.getRootNode?.();
  if (root && root !== document && root.querySelectorAll) {
    return Array.from(root.querySelectorAll('input[type="password"]')).some(isVisible);
  }
  return false;
}

function loginishContext(el) {
  if (LOGINISH.test(location.hostname + location.pathname)) return true;
  const form = el.form;
  if (form && LOGINISH.test(form.getAttribute('action') || '')) return true;
  const scope = form || document;
  return Array.from(scope.querySelectorAll('button, input[type=submit]')).some((b) =>
    /\b(sign[\s-]?in|log[\s-]?in|continue|next)\b/i.test(b.textContent || b.value || ''),
  );
}

function isLoginField(el) {
  if (!isVisible(el)) return false;
  if (isPasswordField(el)) return true;
  if (!isUsernameField(el)) return false;
  const form = el.form;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (ac.includes('username')) return true;
  if (form && Array.from(form.querySelectorAll('input')).some(isPasswordField)) return true;
  if (form && (form.getAttribute('autocomplete') || '').toLowerCase() === 'off') return false;
  if (pageHasVisiblePassword(el)) return true;
  return hasStrongIdentitySignal(el) && loginishContext(el);
}

function isNewPasswordField(el) {
  if (!isPasswordField(el)) return false;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (ac.includes('current-password')) return false;
  if (ac.includes('new-password')) return true;
  const visiblePws = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
  if (visiblePws.length >= 2) return true;
  return Array.from(document.querySelectorAll('button, input[type=submit], input[type=button]')).some((b) =>
    /\b(sign[\s-]?up|register|create[\s-]?account|create[\s-]?your[\s-]?account)\b/i.test(b.textContent || b.value || ''),
  );
}

function appleSignInControl() {
  const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
  return controls.find((control) => {
    if (!isVisible(control)) return false;
    const copy = [
      control.textContent,
      control.value,
      control.getAttribute('aria-label'),
      control.getAttribute('title'),
    ].filter(Boolean).join(' ');
    if (APPLE_SIGN_IN_LABEL.test(copy)) return true;
    const attrs = `${control.id || ''} ${control.className || ''} ${control.getAttribute('name') || ''} ${control.getAttribute('data-provider') || ''}`;
    return APPLE_SIGN_IN_ATTR.test(attrs);
  }) || null;
}

function isSignupContext(el) {
  if (isNewPasswordField(el)) return true;
  if (!isHideEmailField(el)) return false;
  const scope = el.form || document;
  if (SIGNUP_LABEL.test(scope.getAttribute?.('action') || '')) return true;
  return Array.from(scope.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]')).some((control) =>
    SIGNUP_LABEL.test(`${control.textContent || ''} ${control.value || ''} ${control.getAttribute('aria-label') || ''}`),
  );
}

function preparedPasswordForThisSite() {
  if (!lastGenerated || lastGenerated.host !== location.hostname || Date.now() - lastGenerated.at >= 600000) return '';
  return lastGenerated.password || '';
}

function signupPasswordTarget(anchor) {
  const roots = [];
  if (anchor?.form) roots.push(anchor.form);
  roots.push(document);
  for (const root of roots) {
    const fields = Array.from(root.querySelectorAll('input[type="password"]')).filter(isVisible);
    const preferred = fields.find(isNewPasswordField) || fields[0];
    if (preferred) return preferred;
  }
  return null;
}

function isAllowlistedLoginHost(host) {
  host = host.toLowerCase();
  return IFRAME_LOGIN_ALLOWLIST.some((d) => host === d || host.endsWith('.' + d));
}

function frameIsSafe() {
  if (window === window.top) return true;
  if (isAllowlistedLoginHost(location.hostname)) return true;
  try {
    return location.origin === window.top.location.origin;
  } catch {
    return false;
  }
}

function setValue(el, value) {
  const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function domDistance(a, b) {
  const all = Array.from(document.querySelectorAll('input'));
  return all.indexOf(a) - all.indexOf(b);
}

function liveField(field) {
  if (!field || field.isConnected) return field;
  if (field.id) {
    const byId = document.getElementById(field.id);
    if (byId instanceof HTMLInputElement) return byId;
  }
  if (field.name) {
    const byName = document.querySelector(`input[name="${CSS.escape(field.name)}"]`);
    if (byName instanceof HTMLInputElement) return byName;
  }
  return anchorPwField(document) || field;
}

function fillCredentials(username, password, anchor) {
  anchor = liveField(anchor);
  const pool = new Set(document.querySelectorAll('input'));
  const root = anchor?.getRootNode?.();
  if (root && root !== document && root.querySelectorAll) {
    for (const i of root.querySelectorAll('input')) pool.add(i);
  }
  const inputs = Array.from(pool).filter(isFillable);
  let passwords = inputs.filter(isPasswordField);
  let usernames = inputs.filter(isUsernameField);
  const anchorForm = anchor?.form;
  if (anchorForm) {
    const pwInForm = passwords.filter((p) => p.form === anchorForm);
    const userInForm = usernames.filter((u) => u.form === anchorForm);
    if (pwInForm.length) passwords = pwInForm;
    if (userInForm.length) usernames = userInForm;
  }
  let firstPw = passwords[0];
  if (anchor && passwords.length > 1) {
    firstPw = passwords.map((p) => ({ p, d: Math.abs(domDistance(anchor, p)) })).sort((a, b) => a.d - b.d)[0].p;
  }
  let userTarget = null;
  if (username) {
    if (anchor && isUsernameField(anchor)) userTarget = anchor;
    else if (usernames.length) {
      userTarget = usernames[0];
      if (firstPw) {
        const before = usernames.filter((u) => u.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (before.length) userTarget = before[before.length - 1];
      }
    }
  }
  let filled = false;
  if (userTarget) {
    setValue(userTarget, username);
    filled = true;
  }
  if (password && firstPw) {
    setValue(firstPw, password);
    everPassword.add(firstPw);
    filled = true;
  }
  return filled;
}

function fillGeneratedPassword(field, password) {
  field = liveField(field);
  if (!(field instanceof HTMLInputElement) || !password) return false;
  const targets = new Set([field]);
  for (const p of Array.from(document.querySelectorAll('input[type="password"]')).filter(isFillable)) {
    if (p === field || p.value) continue;
    if (p.form && field.form && p.form !== field.form) continue;
    targets.add(p);
  }
  for (const t of targets) {
    setValue(t, password);
    everPassword.add(t);
  }
  lastGenerated = { host: location.hostname, password, at: Date.now() };
  return true;
}

function otpFieldsNear(anchor) {
  anchor = liveField(anchor);
  if (!(anchor instanceof HTMLInputElement)) return [];
  const root = anchor.form || anchor.getRootNode?.() || document;
  const scope = root?.querySelectorAll ? root : document;
  let fields = Array.from(scope.querySelectorAll('input')).filter((el) => isOtpField(el) && isVisible(el));
  if (!fields.includes(anchor) && isOtpField(anchor) && isVisible(anchor)) fields.push(anchor);
  // A split OTP widget normally consists entirely of one-character boxes. Keep the set
  // local to the anchor's form/root so we never spray a code into unrelated inputs.
  const split = fields.filter((el) => parseInt(el.getAttribute('maxlength') || '0', 10) === 1);
  if (parseInt(anchor.getAttribute('maxlength') || '0', 10) === 1 && split.length >= 2) return split;
  return [anchor];
}

function fillOneTimeCode(code, anchor) {
  code = String(code || '').replace(/\s+/g, '');
  if (!code) return false;
  const fields = otpFieldsNear(anchor);
  if (!fields.length) return false;
  if (fields.length === 1) {
    setValue(fields[0], code);
    return true;
  }
  const chars = Array.from(code);
  let filled = false;
  for (let i = 0; i < fields.length && i < chars.length; i++) {
    setValue(fields[i], chars[i]);
    filled = true;
  }
  return filled;
}

function firstVisibleOtpField() {
  return Array.from(document.querySelectorAll('input')).find((el) => isOtpField(el) && isVisible(el)) || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!['fill', 'fillOtp'].includes(msg?.type)) return false;
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, filled: false, error: 'forbidden' });
    return true;
  }
  if (msg.expectedHost && location.hostname.toLowerCase() !== msg.expectedHost) {
    sendResponse({ ok: false, filled: false, error: 'origin mismatch' });
    return true;
  }
  if (msg.type === 'fillOtp') {
    const anchor = fillAnchor && isOtpField(liveField(fillAnchor)) ? liveField(fillAnchor) : firstVisibleOtpField();
    const filled = fillOneTimeCode(msg.code, anchor);
    sendResponse({ ok: true, filled, reason: filled ? undefined : 'no_otp_field' });
    return true;
  }
  const filled = fillCredentials(msg.username, msg.password, fillAnchor);
  if (filled) lastAutofill = { host: location.hostname, username: msg.username, password: msg.password, at: Date.now() };
  sendResponse({ ok: true, filled, reason: filled ? undefined : 'no_login_field' });
  return true;
});

function noteGesture(e, kind) {
  if (!e.isTrusted) return;
  const pathTarget = e.composedPath?.()[0] || e.target;
  lastGesture = { at: Date.now(), kind, target: pathTarget, x: Number(e.clientX) || 0, y: Number(e.clientY) || 0 };
}

document.addEventListener('pointerdown', (e) => {
  noteGesture(e, 'pointer');
  // Clicking an input that is already focused does not emit another focusin event. This is
  // common on pages that autofocus the username field before document_idle installs us.
  // Re-open only when this trusted pointer gesture actually lands on the active field.
  const field = deepActiveElement();
  if (!(field instanceof HTMLInputElement) || !focusWasUserDriven(field)) return;
  const otp = isOtpField(field);
  const signupField = isHideEmailField(field) && isSignupContext(field);
  if (!otp && !isLoginField(field) && !signupField) return;
  Promise.resolve().then(() => {
    if (field === deepActiveElement()) openForField(field);
  });
}, true);
document.addEventListener('keydown', (e) => noteGesture(e, 'keyboard'), true);

function focusWasUserDriven(field) {
  if (Date.now() - lastGesture.at > USER_GESTURE_WINDOW_MS) return false;
  if (lastGesture.kind === 'keyboard') return true;
  if (lastGesture.kind !== 'pointer') return false;
  if (lastGesture.target === field) return true;
  // Clicking a <label> focuses its associated input after pointerdown. Treat that as
  // the same explicit user action instead of requiring the pointer target to be the input.
  const target = lastGesture.target;
  if (target instanceof Element) {
    const label = target.closest('label');
    if (label && (label.control === field || (label.htmlFor && label.htmlFor === field.id))) return true;
  }
  // Some sites place a decorative overlay inside the input bounds. The pointer itself still
  // has to land on the field's visible rectangle; a random click elsewhere cannot unlock it.
  const r = field.getBoundingClientRect();
  return lastGesture.x >= r.left && lastGesture.x <= r.right && lastGesture.y >= r.top && lastGesture.y <= r.bottom;
}

function setImportant(el, prop, value) {
  el.style.setProperty(prop, value, 'important');
}

function applyHostStyle() {
  if (!uiHost || !uiExpectedRect) return;
  uiHost.setAttribute('data-open-passwords-host', 'secure-ui');
  setImportant(uiHost, 'all', 'initial');
  setImportant(uiHost, 'position', 'fixed');
  setImportant(uiHost, 'left', `${uiExpectedRect.left}px`);
  setImportant(uiHost, 'top', `${uiExpectedRect.top}px`);
  setImportant(uiHost, 'width', `${uiExpectedRect.width}px`);
  setImportant(uiHost, 'height', `${uiExpectedRect.height}px`);
  setImportant(uiHost, 'margin', '0');
  setImportant(uiHost, 'padding', '0');
  setImportant(uiHost, 'border', '0');
  setImportant(uiHost, 'background', 'transparent');
  setImportant(uiHost, 'display', 'block');
  setImportant(uiHost, 'visibility', uiAuthenticated ? 'visible' : 'hidden');
  setImportant(uiHost, 'opacity', uiAuthenticated ? '1' : '0');
  setImportant(uiHost, 'transform', 'none');
  setImportant(uiHost, 'filter', 'none');
  setImportant(uiHost, 'clip', 'auto');
  setImportant(uiHost, 'clip-path', 'none');
  setImportant(uiHost, 'overflow', 'visible');
  setImportant(uiHost, 'pointer-events', 'auto');
  setImportant(uiHost, 'z-index', '2147483647');
}

function applyFrameStyle() {
  if (!uiFrame) return;
  setImportant(uiFrame, 'all', 'initial');
  setImportant(uiFrame, 'display', 'block');
  setImportant(uiFrame, 'width', '100%');
  setImportant(uiFrame, 'height', '100%');
  setImportant(uiFrame, 'border', '0');
  setImportant(uiFrame, 'margin', '0');
  setImportant(uiFrame, 'padding', '0');
  setImportant(uiFrame, 'background', 'transparent');
  setImportant(uiFrame, 'pointer-events', 'auto');
  setImportant(uiFrame, 'color-scheme', 'light dark');
}

function computeUiRect(field, height = UI_DEFAULT_HEIGHT) {
  const r = field.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const width = Math.min(UI_MAX_WIDTH, Math.max(UI_MIN_WIDTH, Math.min(r.width, UI_MAX_WIDTH)));
  let left = Math.max(8, Math.min(r.left, vw - width - 8));
  let top = r.bottom + UI_GAP;
  const h = Math.min(UI_MAX_HEIGHT, Math.max(72, height));
  if (top + h > vh - 8 && r.top - UI_GAP - h >= 8) top = r.top - UI_GAP - h;
  else top = Math.min(top, Math.max(8, vh - h - 8));
  return { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(h) };
}

function positionUi(height = uiExpectedRect?.height || UI_DEFAULT_HEIGHT) {
  if (!uiHost || !uiAnchor || !isVisible(uiAnchor)) {
    closeUi();
    return;
  }
  uiExpectedRect = computeUiRect(uiAnchor, height);
  applyHostStyle();
  applyFrameStyle();
}

function closeUi() {
  aliasLookupSeq += 1;
  if (uiAuthTimer) clearTimeout(uiAuthTimer);
  uiAuthTimer = null;
  if (uiPort) {
    try { uiPort.close(); } catch {}
  }
  uiPort = null;
  if (uiHost) uiHost.remove();
  uiHost = null;
  uiShadow = null;
  uiFrame = null;
  uiAnchor = null;
  uiExpectedRect = null;
  uiState = null;
  uiSecret = null;
  uiAuthenticated = false;
  uiLoadCount = 0;
}

function rectNear(a, b, tolerance = 3) {
  if (!a || !b) return false;
  return Math.abs(a.left - b.left) <= tolerance &&
    Math.abs(a.top - b.top) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance;
}

function validateUiAction(msg) {
  if (!uiHost || !uiFrame || !uiAnchor || !uiExpectedRect) return false;
  if (!uiHost.isConnected || !isVisible(uiAnchor)) return false;
  const actual = uiHost.getBoundingClientRect();
  if (!rectNear(actual, uiExpectedRect)) return false;
  const style = getComputedStyle(uiHost);
  if (!uiAuthenticated || style.visibility !== 'visible' || parseFloat(style.opacity || '1') < 0.99 || style.pointerEvents !== 'auto') return false;
  if (msg?.gesture !== true || typeof msg.x !== 'number' || typeof msg.y !== 'number') return false;
  const px = actual.left + msg.x;
  const py = actual.top + msg.y;
  if (px < actual.left || px > actual.right || py < actual.top || py > actual.bottom) return false;
  // A page overlay would win elementFromPoint; a moved host fails the rect comparison above.
  const topElement = document.elementFromPoint(px, py);
  if (topElement !== uiHost) return false;
  try {
    const inside = uiShadow?.elementFromPoint?.(px, py);
    if (inside && inside !== uiFrame) return false;
  } catch {}
  return true;
}

function postUi(message) {
  try { uiPort?.postMessage(message); } catch {}
}

async function refreshExistingHme(anchor, token) {
  const hme = await sendRuntimeMessage({ type: 'hme:inline-state', wantAlias: true })
    .catch(() => null);
  if (token !== aliasLookupSeq || uiAnchor !== anchor || !uiState || isOtpField(anchor)) return;
  if (uiState.logins?.length) return;
  uiState = {
    ...uiState,
    canSmartSignup: isHideEmailField(anchor) && isSignupContext(anchor) && !!hme?.ready,
    existingHme: hme?.existingHme || null,
  };
  postUi(uiState);
}

async function reloadUiState() {
  const anchor = uiAnchor;
  if (!anchor) return;
  if (isOtpField(anchor)) {
    const res = await sendRuntimeMessage({ type: 'inlineOtpItems' }).catch(() => null);
    if (uiAnchor !== anchor) return;
    uiState = {
      type: 'state',
      mode: 'otp',
      language: appResolvedLanguage(),
      host: location.hostname,
      locked: !!(res?.ok && res.locked),
      otpItems: res?.ok && !res.locked ? (res.items || []).map((item) => ({
        username: item.username || '',
        domain: item.domain || '',
        source: item.source || '',
      })) : [],
      lookupError: !res?.ok && !res?.locked
        ? L('Verification-code lookup failed. Click the field again to retry.', '验证码查询失败，请再次点击输入框重试。')
        : '',
      canGenerate: false,
      canUnlock: window === window.top,
    };
  } else {
    const wantsAlias = isHideEmailField(anchor);
    const [res, hme] = await Promise.all([
      sendRuntimeMessage({ type: 'inlineLogins' }).catch(() => null),
      // This is storage-only. Existing-alias discovery is a separate, non-blocking request below.
      sendRuntimeMessage({ type: 'hme:inline-state', wantAlias: false }).catch(() => null),
    ]);
    if (uiAnchor !== anchor) return;
    const logins = res?.ok && !res.locked ? (res.logins || []).map((l) => ({ username: l.username || '' })) : [];
    const hasSavedLogins = logins.length > 0;
    uiState = {
      type: 'state',
      mode: 'password',
      language: appResolvedLanguage(),
      host: location.hostname,
      locked: !!(res?.ok && res.locked),
      logins,
      lookupError: !res?.ok && !res?.locked
        ? L('Apple Passwords lookup failed. Click the field again to retry.', 'Apple 密码查询失败，请再次点击输入框重试。')
        : '',
      canGenerate: !hasSavedLogins && isNewPasswordField(anchor),
      canSmartSignup: !hasSavedLogins && wantsAlias && isSignupContext(anchor) && !!hme?.ready,
      hasAppleSignIn: !hasSavedLogins && !!appleSignInControl(),
      existingHme: null,
      pendingPassword: preparedPasswordForThisSite(),
      canUnlock: window === window.top,
    };
  }
  postUi(uiState);
  if (!isOtpField(anchor) && isHideEmailField(anchor) && !uiState.logins?.length) {
    const token = ++aliasLookupSeq;
    refreshExistingHme(anchor, token).catch(() => {});
  }
}

async function handleUiAction(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'resize') {
    const height = Math.min(UI_MAX_HEIGHT, Math.max(72, Number(msg.height) || UI_DEFAULT_HEIGHT));
    positionUi(height);
    return;
  }
  if (msg.type === 'close') {
    closeUi();
    return;
  }
  if (!validateUiAction(msg)) {
    closeUi();
    return;
  }

  if (msg.type === 'fill-otp') {
    if (!isOtpField(uiAnchor)) return;
    fillAnchor = uiAnchor;
    const username = typeof msg.username === 'string' ? msg.username : '';
    const res = await sendRuntimeMessage({ type: 'inlineFillOtp', username }).catch((e) => ({ ok: false, error: String(e) }));
    if (res?.filled) closeUi();
    else postUi({
      type: 'error',
      message: res?.reason === 'no_otp_field'
        ? L('No verification-code field was found in this sign-in step.', '当前登录步骤中没有找到验证码输入框。')
        : (res?.error || L('Could not fill this verification code.', '无法填充此验证码。')),
    });
    return;
  }

  if (msg.type === 'fill-login') {
    const username = typeof msg.username === 'string' ? msg.username : '';
    fillAnchor = uiAnchor;
    const res = await sendRuntimeMessage({ type: 'inlineFill', loginName: { username } }).catch((e) => ({ ok: false, error: String(e) }));
    if (res?.filled) closeUi();
    else postUi({
      type: 'error',
      message: res?.reason === 'no_login_field'
        ? L('No compatible username or password field was found in this sign-in step.', '当前登录步骤中没有找到可填充的账号或密码输入框。')
        : (res?.error || L('Could not fill this login.', '无法填充此登录信息。')),
    });
    return;
  }

  if (msg.type === 'use-apple-sign-in') {
    const control = appleSignInControl();
    if (!control) {
      postUi({ type: 'error', message: L('The Sign in with Apple button is no longer available.', '“使用 Apple 登录”按钮已不可用。') });
      return;
    }
    closeUi();
    try { control.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
    try { control.focus({ preventScroll: true }); } catch {}
    setTimeout(() => control.click(), 0);
    return;
  }

  if (msg.type === 'smart-signup') {
    if (!isHideEmailField(uiAnchor) || typeof msg.password !== 'string' || msg.password.length < 8) return;
    let alias = typeof msg.hme === 'string' && msg.hme.includes('@') ? msg.hme : '';
    if (!alias) {
      const result = await sendRuntimeMessage({ type: 'hme:create-for-site' }).catch((e) => ({ ok: false, error: String(e) }));
      if (!result?.ok || !result.hme) {
        postUi({ type: 'error', message: result?.error || L('Could not create a private signup address.', '无法创建私密注册地址。') });
        return;
      }
      alias = String(result.hme);
    }

    const anchor = uiAnchor;
    setValue(anchor, alias);
    const passwordField = signupPasswordTarget(anchor);
    if (passwordField) fillGeneratedPassword(passwordField, msg.password);
    else lastGenerated = { host: location.hostname, password: msg.password, at: Date.now(), pending: true };
    anchor.focus();
    closeUi();
    return;
  }

  if (msg.type === 'generate-password') {
    if (!isNewPasswordField(uiAnchor) || typeof msg.password !== 'string' || msg.password.length < 8) return;
    if (fillGeneratedPassword(uiAnchor, msg.password)) closeUi();
    return;
  }

  if (msg.type === 'request-unlock') {
    if (window !== window.top) {
      postUi({ type: 'error', message: L('Unlock from the toolbar on embedded sign-in pages.', '在嵌入式登录页面中，请从工具栏解锁。') });
      return;
    }
    const res = await sendRuntimeMessage({ type: 'requestChallenge', ifNeeded: true }).catch((e) => ({ ok: false, error: String(e) }));
    if (res?.ok) postUi({ type: 'pin-ready' });
    else postUi({ type: 'error', message: res?.error || L('Could not request an Apple Passwords code.', '无法请求 Apple 密码验证码。') });
    return;
  }

  if (msg.type === 'new-code') {
    if (window !== window.top) return;
    const res = await sendRuntimeMessage({ type: 'requestChallenge' }).catch((e) => ({ ok: false, error: String(e) }));
    postUi(res?.ok ? { type: 'pin-ready', fresh: true } : { type: 'error', message: res?.error || L('Could not request a new code.', '无法请求新的验证码。') });
    return;
  }

  if (msg.type === 'verify-pin') {
    if (window !== window.top) return;
    const pin = String(msg.pin || '').replace(/\D/g, '').slice(0, 6);
    if (pin.length !== 6) return;
    const res = await sendRuntimeMessage({ type: 'verifyPin', pin }).catch((e) => ({ ok: false, error: String(e) }));
    if (res?.ok && res.state === 'unlocked') {
      await reloadUiState();
    } else {
      postUi({
        type: 'pin-error',
        message: res?.newCode ? `${res?.error || L('Verification failed', '验证失败')} — ${L('enter the new code on your Mac.', '请输入 Mac 上显示的新验证码。')}` : (res?.error || L('Verification failed.', '验证失败。')),
        newCode: !!res?.newCode,
      });
    }
  }
}

function buildSecureUi(field, state) {
  closeUi();
  uiAnchor = field;
  uiState = state;
  uiExpectedRect = computeUiRect(field, UI_DEFAULT_HEIGHT);

  const host = document.createElement('div');
  uiHost = host;
  applyHostStyle();
  uiShadow = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  const secretBytes = new Uint8Array(16);
  crypto.getRandomValues(secretBytes);
  uiSecret = Array.from(secretBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  frame.src = `${UI_URL}#${uiSecret}`;
  frame.setAttribute('title', 'Apple Passwords');
  frame.setAttribute('aria-label', 'Apple Passwords suggestions');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  uiFrame = frame;
  uiAuthenticated = false;
  uiLoadCount = 0;
  frame.addEventListener('load', () => {
    uiLoadCount += 1;
    if (uiLoadCount > 1) closeUi(); // a page tried to navigate our isolated extension frame
  });
  applyFrameStyle();
  uiShadow.appendChild(frame);
  (document.documentElement || document.body).appendChild(host);

  uiAuthTimer = setTimeout(() => { if (!uiAuthenticated) closeUi(); }, 1800);
  positionUi();
}

window.addEventListener('message', (event) => {
  if (!uiFrame || event.source !== uiFrame.contentWindow || event.origin !== EXT_ORIGIN) return;
  if (event.data?.type !== 'openpasswords-inline-ready' || uiPort) return;
  const channel = new MessageChannel();
  uiPort = channel.port1;
  uiPort.onmessage = (e) => handleUiAction(e.data);
  uiPort.start?.();
  uiFrame.contentWindow.postMessage({ type: 'openpasswords-port', secret: uiSecret }, EXT_ORIGIN, [channel.port2]);
  uiAuthenticated = true;
  if (uiAuthTimer) clearTimeout(uiAuthTimer);
  uiAuthTimer = null;
  applyHostStyle();
  postUi(uiState);
});

async function openForField(field) {
  if (!(field instanceof HTMLInputElement) || !frameIsSafe()) return;
  const otp = isOtpField(field);
  const signupField = isHideEmailField(field) && isSignupContext(field);
  if (!otp && !isLoginField(field) && !signupField) return;
  const seq = ++offerSeq;
  const [res, hme] = otp
    ? [await sendRuntimeMessage({ type: 'inlineOtpItems' }).catch(() => null), null]
    : await Promise.all([
        sendRuntimeMessage({ type: 'inlineLogins' }).catch(() => null),
        // Keep the password lookup independent from the potentially slow iCloud alias list.
        sendRuntimeMessage({ type: 'hme:inline-state', wantAlias: false }).catch(() => null),
      ]);
  if (seq !== offerSeq || field !== deepActiveElement()) return;
  const logins = !otp && res?.ok && !res.locked
    ? (res.logins || []).map((l) => ({ username: l.username || '' }))
    : [];
  const hasSavedLogins = logins.length > 0;
  const state = otp ? {
    type: 'state',
    mode: 'otp',
    host: location.hostname,
    locked: !!(res?.ok && res.locked),
    otpItems: res?.ok && !res.locked ? (res.items || []).map((item) => ({
      username: item.username || '',
      domain: item.domain || '',
      source: item.source || '',
    })) : [],
    lookupError: !res?.ok && !res?.locked
      ? L('Verification-code lookup failed. Click the field again to retry.', '验证码查询失败，请再次点击输入框重试。')
      : '',
    canGenerate: false,
    canUnlock: window === window.top,
  } : {
    type: 'state',
    mode: 'password',
    host: location.hostname,
    locked: !!(res?.ok && res.locked),
    logins,
    lookupError: !res?.ok && !res?.locked
      ? L('Apple Passwords lookup failed. Click the field again to retry.', 'Apple 密码查询失败，请再次点击输入框重试。')
      : '',
    canGenerate: !hasSavedLogins && isNewPasswordField(field),
    canSmartSignup: !hasSavedLogins && isHideEmailField(field) && isSignupContext(field) && !!hme?.ready,
    hasAppleSignIn: !hasSavedLogins && !!appleSignInControl(),
    existingHme: null,
    pendingPassword: preparedPasswordForThisSite(),
    canUnlock: window === window.top,
  };
  const hasItems = otp ? state.otpItems.length > 0 : state.logins.length > 0;
  if (!state.locked && !hasItems && !state.lookupError && !state.canGenerate && !state.canSmartSignup && !state.hasAppleSignIn) return;
  buildSecureUi(field, state);
  if (!otp && !hasSavedLogins && isHideEmailField(field) && hme?.ready) {
    const token = ++aliasLookupSeq;
    refreshExistingHme(field, token).catch(() => {});
  }
}

function deepActiveElement() {
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

document.addEventListener('focusin', (e) => {
  const field = e.composedPath?.()[0] || e.target;
  if (uiHost && field !== uiAnchor) closeUi();
  if (field instanceof HTMLInputElement && field.type === 'password') everPassword.add(field);
  if (!(field instanceof HTMLInputElement)) return;

  const otp = isOtpField(field);
  const signupField = isHideEmailField(field) && isSignupContext(field);
  if (!otp && !isLoginField(field) && !signupField) return;
  // Password-account enumeration still needs an explicit recent user gesture. OTP metadata is
  // different: cmd 16 is a secret-free lookup (the actual TOTP is only fetched by cmd 17
  // after a trusted click inside our extension-origin chooser). Allowing script/autofocus on
  // an OTP field makes the suggestion appear as soon as a 2FA step focuses its code box,
  // matching Safari/Apple Passwords behavior without exposing the code to the page.
  if (!otp && !focusWasUserDriven(field)) return;

  if (lastAutofill && Date.now() - lastAutofill.at < 8000) {
    const v = (field.value || '').trim();
    if (v && (v === (lastAutofill.username || '') || v === (lastAutofill.password || ''))) return;
  }
  openForField(field);
}, true);

function openInitiallyFocusedOtp() {
  const field = deepActiveElement();
  if (!(field instanceof HTMLInputElement) || !isOtpField(field) || !isVisible(field) || !frameIsSafe()) return;
  openForField(field);
}

// document_idle can run after an autofocus field already received focus, so no focusin event
// would reach our listener. Re-check the active element once after installation and again on
// pageshow (BFCache/back-forward restores can preserve focus as well).
setTimeout(openInitiallyFocusedOtp, 0);
window.addEventListener('pageshow', () => setTimeout(openInitiallyFocusedOtp, 0));

document.addEventListener('pointerdown', (e) => {
  if (!uiHost) return;
  const target = e.composedPath?.()[0] || e.target;
  if (target === uiAnchor) return;
  // Clicks inside the closed shadow/iframe don't bubble here. Any page click elsewhere closes it.
  closeUi();
}, true);

document.addEventListener('scroll', () => { if (uiHost) positionUi(); }, true);
window.addEventListener('resize', () => { if (uiHost) positionUi(); }, true);

function isSubmitControl(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  if ((tag === 'button' || tag === 'input') && type === 'submit') return true;
  const attrs = `${el.getAttribute('name') || ''} ${el.id || ''}`;
  if (tag === 'button' && (type === '' || type === 'button')) return SUBMITY_LABEL.test(el.textContent || el.value || '') || SUBMITY_ATTR.test(attrs);
  if (tag === 'input' && type === 'button') return SUBMITY_LABEL.test(el.value || '') || SUBMITY_ATTR.test(attrs);
  if ((el.getAttribute('role') || '').toLowerCase() === 'button' || tag === 'a') return SUBMITY_LABEL.test(el.textContent || attrBlob(el) || '');
  return false;
}

function collectSubmittedCredentials(scope) {
  const root = scope?.querySelectorAll ? scope : document;
  const inputs = Array.from(root.querySelectorAll('input'));
  const pws = inputs.filter((i) => isPasswordish(i) && i.value);
  if (!pws.length) return null;
  let password = pws[pws.length - 1].value;
  const counts = new Map();
  for (const p of pws) counts.set(p.value, (counts.get(p.value) || 0) + 1);
  const dup = [...counts.entries()].find(([, n]) => n >= 2);
  const marked = pws.find((p) => (p.getAttribute('autocomplete') || '').toLowerCase().includes('new-password'));
  if (dup) password = dup[0];
  else if (marked) password = marked.value;
  const firstPw = pws[0];
  const before = (el) => !!(el.compareDocumentPosition(firstPw) & Node.DOCUMENT_POSITION_FOLLOWING);
  const pwValues = new Set(pws.map((p) => p.value));
  const usable = (i) => !isPasswordish(i) && !pwValues.has((i.value || '').trim());
  const strict = inputs.filter((i) => isUsernameField(i) && i.value && usable(i));
  const strictBefore = strict.filter(before);
  let userEl = strictBefore.length ? strictBefore[strictBefore.length - 1] : strict[0] || null;
  if (!userEl) {
    const guess = inputs.filter((i) => {
      const v = (i.value || '').trim();
      if (!v || !usable(i) || isOtpField(i) || isSearchOrComboField(i)) return false;
      const t = (i.type || 'text').toLowerCase();
      if (!['text', 'email', 'tel', ''].includes(t) || NONLOGIN_HINT.test(attrBlob(i))) return false;
      if (v.length < 3 || (/^\d+$/.test(v) && v.length < 6)) return false;
      return before(i);
    });
    userEl = guess.length ? guess[guess.length - 1] : null;
  }
  return { username: (userEl?.value || '').trim(), password, allPasswords: pws.map((p) => p.value) };
}

function anchorPwField(root) {
  const scope = root?.querySelectorAll ? root : document;
  const pws = Array.from(scope.querySelectorAll('input')).filter(isPasswordish);
  return pws.find(isVisible) || pws[0] || null;
}

async function maybeOfferSave(scope) {
  if (!frameIsSafe()) return;
  const cred = collectSubmittedCredentials(scope);
  if (!cred?.password) return;
  const genPw = lastGenerated && Date.now() - lastGenerated.at < 600000 ? lastGenerated.password : null;
  const generated = !!genPw && (cred.allPasswords || []).includes(genPw);
  const savePassword = generated ? genPw : cred.password;
  if (!generated && lastAutofill && lastAutofill.host === location.hostname && lastAutofill.password === cred.password && Date.now() - lastAutofill.at < 300000) return;
  const key = `${location.hostname} ${cred.username || savePassword}`;
  const now = Date.now();
  if (key === lastSaveKey && now - lastSaveAt < 15000) return;
  lastSaveKey = key;
  lastSaveAt = now;
  const root = scope?.querySelectorAll ? scope : document;
  const pwInputs = Array.from(root.querySelectorAll('input')).filter(isPasswordish);
  const newPwCtx = generated || (cred.allPasswords || []).length >= 2 || pwInputs.some((p) => (p.getAttribute('autocomplete') || '').toLowerCase().includes('new-password'));
  sendRuntimeMessage({
    type: 'resolveSave',
    username: cred.username,
    password: savePassword,
    generated,
    newPwCtx,
  }).catch(() => {});
}

document.addEventListener('submit', (e) => {
  if (!e.isTrusted) return;
  closeUi();
  maybeOfferSave(e.target);
}, true);

document.addEventListener('click', (e) => {
  if (!e.isTrusted || !(e.target instanceof Element)) return;
  const ctrl = e.target.closest('button, input[type=submit], input[type=button], [role="button"], a');
  if (isSubmitControl(ctrl)) maybeOfferSave(ctrl?.form || document);
}, true);

document.addEventListener('keydown', (e) => {
  if (!e.isTrusted || e.key !== 'Enter') return;
  const t = e.composedPath?.()[0] || e.target;
  if (t instanceof HTMLInputElement && (isPasswordField(t) || isUsernameField(t))) {
    closeUi();
    maybeOfferSave(t.form || document);
  }
}, true);
})();
