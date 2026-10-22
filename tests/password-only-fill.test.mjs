import assert from 'node:assert/strict';
import test from 'node:test';
import { functionsFrom } from './source-harness.mjs';
import { ApplePasswords, Command, State } from '../src/passwords/core/protocol.js';
import { createPasswordCache } from '../src/passwords/core/password-cache.js';
import { accountKey } from '../src/passwords/core/account-identity.js';

class Field {
  constructor(attrs = {}) {
    this.attrs = { type: 'password', name: 'token', autocomplete: 'current-password', ...attrs };
    Object.assign(this, this.attrs, { labels: [], value: '', isConnected: true, disabled: false, readOnly: false });
  }
  getAttribute(key) { return this.attrs[key] ?? null; }
}
function detection() {
  return functionsFrom('src/passwords/content.js', [
    'OTP_AUTOCOMPLETE', 'OTP_HINT', 'OTP_HINT_CJK', 'identifierWords', 'attrBlob', 'isOtpField',
    'isPasswordField', 'isLoginField',
  ], { HTMLInputElement: Field, isVisible: () => true });
}

test('current-password and new-password override ambiguous token/code hints', () => {
  const context = detection();
  for (const autocomplete of ['current-password', 'new-password', 'section-admin current-password']) {
    const field = new Field({ autocomplete, name: 'token', 'aria-label': 'Security code', inputMode: 'numeric', maxlength: '6' });
    assert.equal(context.isOtpField(field), false, autocomplete);
    assert.equal(context.isLoginField(field), true);
  }
});

test('permanent tokens and passcodes are not OTP without one-time or bounded numeric evidence', () => {
  const context = detection();
  for (const name of ['token', 'admin-token', 'api_token', 'passcode']) {
    assert.equal(context.isOtpField(new Field({ name, autocomplete: 'off' })), false, name);
  }
  for (const attrs of [
    { autocomplete: 'one-time-code' },
    { autocomplete: 'off', name: 'otp' },
    { autocomplete: 'off', name: 'token', 'aria-label': 'One-time token' },
    { autocomplete: 'off', name: 'token', inputMode: 'numeric', maxlength: '6' },
    { autocomplete: 'off', name: 'passcode', inputMode: 'numeric', maxlength: '6' },
    { autocomplete: 'off', name: 'totp', placeholder: '动态口令' },
  ]) assert.equal(context.isOtpField(new Field(attrs)), true, JSON.stringify(attrs));
});

test('toolgrep-style password-only field shows the saved login with an empty username', async () => {
  const field = new Field();
  const messages = [], states = [];
  const context = functionsFrom('src/passwords/content.js', ['openForField', 'loginMetadata', 'inlineLookupError'], {
    ...detection(), sitePreferences: { suggestions: 'automatic', privateSignup: false },
    extensionContextInvalidated: false, pageInactive: false, offerSeq: 0, aliasLookupSeq: 0,
    frameIsSafe: () => true, isHideEmailField: () => false, isNewPasswordField: () => false,
    location: { hostname: 'toolgrep.com' }, window: { top: {} },
    sendRuntimeMessage: async (message) => {
      messages.push(message.type);
      return message.type === 'inlineLogins' ? { ok: true, logins: [{ username: '', sites: ['toolgrep.com'] }] }
        : { ok: true, items: [] };
    },
    deepActiveElement: () => field, appleSignInControl: () => null,
    preparedPasswordForThisSite: () => '', passwordRequirementsFor: () => ({}),
    buildSecureUi: (_field, state) => states.push(state), L: (en) => en,
  });
  await context.openForField(field);
  assert.deepEqual(messages, ['inlineLogins']);
  assert.equal(states.length, 1);
  assert.equal(states[0].mode, 'password');
  assert.equal(states[0].logins[0].username, '');
});

function native(entries) {
  const client = new ApplePasswords();
  Object.assign(client, { port: {}, session: { sharedKey: 'synthetic' }, state: State.Unlocked });
  const queries = [];
  client._encryptedQuery = async (...args) => { queries.push(args); return { STATUS: 0, Entries: entries }; };
  return { client, queries };
}

test('unnamed saved passwords survive native lookup, exact selection, cache and password-only fill', async () => {
  const { client, queries } = native([
    { USR: 'named-account', PWD: 'OtherSyntheticSecret', sites: ['toolgrep.com'] },
    { PWD: 'SyntheticToken!', sites: ['toolgrep.com'] },
  ]);
  const logins = await client.getLoginNamesForURL(7, 'https://toolgrep.com/admin/login');
  assert.ok(logins.some((login) => login.username === ''));
  const credential = await client.getPasswordForLoginName(7, 'https://toolgrep.com/admin/login', { username: '' });
  assert.equal(queries[1][0], Command.GET_PASSWORD_FOR_LOGIN_NAME);
  assert.equal(queries[1][3].USR, '');
  assert.equal(credential.username, '');
  assert.equal(credential.password, 'SyntheticToken!');
  let now = 0;
  const cache = createPasswordCache({ idleTtlMs: 120_000, maxTtlMs: 300_000, now: () => now });
  cache.set('toolgrep.com', credential);
  assert.equal(cache.get('toolgrep.com', ''), credential);
  assert.equal(cache.get('other.test', ''), null);
  assert.equal(cache.get('toolgrep.com', 'named-account'), null);

  const field = new Field();
  const context = functionsFrom('src/passwords/content.js', ['fillCredentials', 'writeField'], {
    ...detection(), isFillable: () => true, formScope: () => ({}), deepInputs: () => [field],
    passwordRole: () => 'current', isUsernameField: () => false,
    setValue: (target, value) => { target.value = value; }, everPassword: new WeakSet(),
  });
  assert.equal(context.fillCredentials(credential.username, credential.password, field), true);
  assert.equal(field.value, 'SyntheticToken!');
  now = 120_001;
  assert.equal(cache.get('toolgrep.com', ''), null);
  cache.clear();
});

test('multiple distinct unnamed passwords still fail closed', async () => {
  const { client } = native(['first', 'second'].map((password) => ({ USR: '', PWD: password, sites: ['toolgrep.com'] })));
  await assert.rejects(client.getPasswordForLoginName(7, 'https://toolgrep.com/admin/login', { username: '' }),
    (error) => error.code === 'ambiguous_account');
});

test('unnamed saved login can be remembered without accepting missing account metadata', () => {
  const mruByHost = new Map();
  const context = functionsFrom('src/passwords/core/background.js', ['recordMru'], { mruByHost, accountKey });
  context.recordMru('toolgrep.com', '');
  assert.deepEqual([...mruByHost.get('toolgrep.com')], ['']);
  context.recordMru('toolgrep.com', undefined);
  assert.equal(mruByHost.get('toolgrep.com').length, 1);
});
