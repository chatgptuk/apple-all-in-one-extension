import assert from 'node:assert/strict';
import test from 'node:test';
import { contentMessageHandler, functionsFrom } from './source-harness.mjs';
import { formScope } from '../src/passwords/form-context.js';
import { validContentFillRequest } from '../src/passwords/message-contracts.js';

const source = 'src/passwords/content.js';
const ownerDocument = { getElementById: () => null };

class Field {
  constructor(attrs = {}, extra = {}) {
    this.attrs = attrs;
    Object.assign(this, {
      type: attrs.type || 'text',
      name: attrs.name || '',
      id: attrs.id || '',
      placeholder: attrs.placeholder || '',
      inputMode: attrs.inputmode || '',
      value: '',
      isConnected: true,
      disabled: false,
      readOnly: false,
      form: null,
      labels: [],
      ownerDocument,
    }, extra);
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  focus() { if (this.unlockOn === 'focus') this.readOnly = false; }
  dispatchEvent(event) { if (this.unlockOn === 'event' && event.type === 'focus') this.readOnly = false; }
}

test('field hints recognize identifier-style and localized names without widening to non-login fields', () => {
  const hints = functionsFrom(source, [
    'OTP_AUTOCOMPLETE', 'OTP_HINT', 'OTP_HINT_CJK', 'USERNAME_HINT', 'CAPTCHA_HINT', 'NONLOGIN_HINT',
    'identifierWords', 'attrBlob', 'isOtpField', 'isSearchOrComboField', 'hasStrongIdentitySignal',
    'isUsernameField', 'isPlainTextEntry', 'isLikelyUsernameInput',
  ], { HTMLInputElement: Field });
  for (const attrs of [{ name: 'txtUserName' }, { name: 'j_username' }, { name: 'loginName' }, { name: 'user_email' },
    { name: 'account', placeholder: '手机号/邮箱' }, { name: 'f1', placeholder: '请输入用户名' }]) {
    assert.equal(hints.isUsernameField(new Field(attrs)), true, JSON.stringify(attrs));
  }
  for (const attrs of [{ name: 'accountNo' }, { name: 'firstName' }, { name: 'q', type: 'search' }, { name: 'otpCode' }]) {
    assert.equal(hints.isUsernameField(new Field(attrs)), false, JSON.stringify(attrs));
  }
  assert.equal(hints.isOtpField(new Field({ name: 'otpCode' })), true);
  assert.equal(hints.isOtpField(new Field({ name: 'code', placeholder: '请输入谷歌验证码' })), true);
  assert.equal(hints.isOtpField(new Field({ name: 'dyn', placeholder: '动态口令' })), true);
  // A bare 验证码 is as often an image captcha or SMS code; keep it out of OTP auto-detection.
  assert.equal(hints.isOtpField(new Field({ name: 'vc', placeholder: '图形验证码' })), false);
  assert.equal(hints.isLikelyUsernameInput(new Field({ name: 'captcha' })), false);
  assert.equal(hints.isLikelyUsernameInput(new Field({ name: 'f1', placeholder: '看不清？换一张' })), false);
  assert.equal(hints.isLikelyUsernameInput(new Field({ name: 'q', type: 'search' })), false);
  assert.equal(hints.isLikelyUsernameInput(new Field({ name: 'otp', autocomplete: 'one-time-code' })), false);
  assert.equal(hints.isLikelyUsernameInput(new Field({ name: 'mobile', type: 'tel' })), true);
});

function targets({ active = null, fields = [], otp = null } = {}) {
  return functionsFrom(source, ['fillTargetFor', 'bestLoginField'], {
    HTMLInputElement: Field,
    deepActiveElement: () => active,
    document: {},
    deepInputs: () => fields,
    uiAnchor: null,
    fillAnchor: null,
    isFillable: (field) => field.isConnected && !field.disabled,
    isOtpField: (field) => field.kind === 'otp',
    isUsernameField: (field) => field.kind === 'username',
    isPasswordField: (field) => field.type === 'password',
    isLoginField: () => true,
    passwordRole: (field) => field.role || 'unknown',
    isPlainTextEntry: (field) => ['plain', 'username', 'otp'].includes(field.kind),
    isLikelyUsernameInput: (field) => field.kind === 'plain',
    firstVisibleOtpField: () => otp,
  });
}

test('fill targets follow the request, not whichever control happens to be focused', () => {
  const checkbox = new Field({ type: 'checkbox' });
  const search = new Field({ type: 'search' }, { kind: 'search' });
  const username = new Field({ name: 'username' }, { kind: 'username' });
  const password = new Field({ type: 'password' });
  const code = new Field({ name: 'code' }, { kind: 'otp' });
  const plain = new Field({ name: 'f1' }, { kind: 'plain' });

  assert.equal(targets({ active: checkbox, otp: code }).fillTargetFor('otp'), code);
  assert.equal(targets({ active: username, otp: code }).fillTargetFor('otp'), code);
  assert.equal(targets({ active: username }).fillTargetFor('otp'), null, 'a code never goes into a username field');
  assert.equal(targets({ active: plain }).fillTargetFor('otp'), plain, 'an unrecognized focused code box is a last resort');

  assert.equal(targets({ active: search, fields: [search, username, password] }).fillTargetFor('login'), password);
  assert.equal(targets({ active: username, fields: [username, password] }).fillTargetFor('login'), username);
  assert.equal(targets({ active: code, fields: [code] }).fillTargetFor('login'), null);
  assert.equal(targets({ active: plain, fields: [plain] }).fillTargetFor('login'), plain);
});

function credentials(fields) {
  const form = { fields };
  for (const field of fields) field.form = form;
  const context = functionsFrom(source, ['fillCredentials', 'writeField'], {
    HTMLInputElement: Field,
    FocusEvent: class { constructor(type) { this.type = type; } },
    formScope: () => form,
    deepInputs: (scope) => scope.fields,
    isFillable: (field, { allowReadOnly = false } = {}) => field.isConnected && !field.disabled && (allowReadOnly || !field.readOnly),
    isPasswordField: (field) => field.type === 'password',
    passwordRole: (field) => field.role || 'unknown',
    isUsernameField: (field) => field.kind === 'username',
    hasStrongIdentitySignal: (field) => !!field.strong,
    isLikelyUsernameInput: (field) => field.kind === 'plain',
    setValue: (field, value) => { field.value = value; },
    everPassword: new WeakSet(),
    fillFocusing: false,
  });
  return (anchor) => context.fillCredentials('user@example.test', 'Synthetic1!', anchor);
}

test('saved credentials reach login fields that hide behind anti-autofill markup', () => {
  // A login form that marks its only password new-password to stop browser autofill.
  let user = new Field({ name: 'username' }, { kind: 'username' });
  let pass = new Field({ type: 'password' }, { role: 'new' });
  assert.equal(credentials([user, pass])(user), true);
  assert.deepEqual([user.value, pass.value], ['user@example.test', 'Synthetic1!']);

  // Sign-up new/confirmation fields never receive a saved password.
  user = new Field({ name: 'email' }, { kind: 'username' });
  pass = new Field({ type: 'password' }, { role: 'new' });
  const confirm = new Field({ type: 'password' }, { role: 'confirm' });
  credentials([user, pass, confirm])(user);
  assert.deepEqual([pass.value, confirm.value], ['', '']);

  // An unrecognized username box before the password is used; a captcha after it is not.
  const plain = new Field({ name: 'f1' }, { kind: 'plain' });
  pass = new Field({ type: 'password' });
  const after = new Field({ name: 'f2' }, { kind: 'plain' });
  assert.equal(credentials([plain, pass, after])(pass), true);
  assert.deepEqual([plain.value, pass.value, after.value], ['user@example.test', 'Synthetic1!', '']);

  // Readonly-until-focus inputs unlock even when the page has no system focus (synthetic event).
  user = new Field({ name: 'username' }, { kind: 'username', readOnly: true, unlockOn: 'event' });
  pass = new Field({ type: 'password' }, { readOnly: true, unlockOn: 'focus' });
  assert.equal(credentials([user, pass])(user), true);
  assert.deepEqual([user.value, pass.value], ['user@example.test', 'Synthetic1!']);

  // A genuinely readonly username (step two of a sign-in) is left alone.
  user = new Field({ name: 'username' }, { kind: 'username', readOnly: true });
  user.value = 'shown@example.test';
  pass = new Field({ type: 'password' });
  assert.equal(credentials([user, pass])(pass), true);
  assert.deepEqual([user.value, pass.value], ['shown@example.test', 'Synthetic1!']);
});

test('a per-field fieldset is not mistaken for the whole sign-in form', () => {
  const container = { fields: [], querySelectorAll() { return this.fields; } };
  const wrap = (field) => {
    const fieldset = { fields: [field], parentElement: container, querySelectorAll() { return this.fields; } };
    Object.assign(field, { parentElement: fieldset, closest: () => fieldset, getRootNode: () => ownerDocument, ownerDocument });
    return field;
  };
  const email = wrap(new Field({ name: 'email', type: 'email' }));
  const password = wrap(new Field({ name: 'password', type: 'password' }));
  container.fields = [email, password];
  assert.equal(formScope(email), container);
});

test('a code lease cannot deliver a password and vice versa', () => {
  const code = new Field({ name: 'code' }, { kind: 'otp' });
  let filled = 0;
  const context = contentMessageHandler({
    chrome: { runtime: { id: 'test' } },
    HTMLInputElement: Field,
    documentToken: 'document-A',
    pendingFill: null,
    location: { href: 'https://example.test/2fa', origin: 'https://example.test', hostname: 'example.test' },
    deepActiveElement: () => code,
    uiAnchor: null,
    fillAnchor: null,
    isFillable: (field) => field.isConnected,
    isOtpField: (field) => field.kind === 'otp',
    firstVisibleOtpField: () => code,
    fillOneTimeCode: () => { filled++; return true; },
    fillCredentials: () => { filled++; return true; },
  });
  const message = (value) => {
    let result;
    context.listener(value, { id: 'test' }, (r) => { result = r; });
    return result;
  };
  const lease = message({ type: 'prepareFill', expectedOrigin: 'https://example.test', purpose: 'otp' });
  const binding = { expectedOrigin: 'https://example.test', expectedDocumentToken: lease.documentToken, targetToken: lease.targetToken };
  assert.equal(message({ type: 'fill', username: 'Admin', password: 'synthetic', ...binding }).reason, 'target_changed');
  const next = message({ type: 'prepareFill', expectedOrigin: 'https://example.test', purpose: 'otp' });
  assert.equal(message({ type: 'fillOtp', code: '123456', ...binding, targetToken: next.targetToken }).filled, true);
  assert.equal(filled, 1);
  assert.equal(validContentFillRequest({ type: 'prepareFill', purpose: 'otp' }), true);
  assert.equal(validContentFillRequest({ type: 'prepareFill', purpose: 'secret' }), false);
});
