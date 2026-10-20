import assert from 'node:assert/strict';
import test from 'node:test';
import { contentMessageHandler, functionsFrom, runtimeMessageHandler } from './source-harness.mjs';
import { accountKey } from '../src/passwords/core/account-identity.js';
import { formScope, deepInputs } from '../src/passwords/form-context.js';
import { failureReason, failureMessage, validContentFillRequest } from '../src/passwords/message-contracts.js';
import { SITE_PREFERENCES_KEY, sitePreferencesFor } from '../src/passwords/site-preferences.js';

const url = 'https://auth.uber.com/v2/';
const username = 'synthetic@example.test';
class Field {
  constructor(type = 'email') {
    Object.assign(this, { type, id: 'PHONE_NUMBER_or_EMAIL_ADDRESS', name: 'email',
      autocomplete: 'email webauthn', placeholder: 'Enter phone number or email',
      inputMode: 'email', labels: [], value: '', isConnected: true, disabled: false,
      readOnly: false, form: null });
  }
  getAttribute(name) { return this[name] || null; }
  closest() { return null; }
  getRootNode() { return this.ownerDocument; }
}

function harness({ kind = 'inlineFill', metadata = [{ username }], secretAvailable = false } = {}) {
  const field = new Field();
  const document = { querySelectorAll: () => fields, getElementById: () => null };
  const fields = [field];
  const parent = { ownerDocument: document, querySelectorAll: () => fields, getRootNode: () => document };
  Object.assign(field, { parentElement: parent, ownerDocument: document });
  const state = { secretReads: 0, metadataReads: 0, writes: 0, duringLookup: null };
  const messages = [];
  const predicates = functionsFrom('src/passwords/content.js', [
    'OTP_AUTOCOMPLETE', 'OTP_HINT', 'OTP_HINT_CJK', 'USERNAME_HINT', 'CAPTCHA_HINT', 'NONLOGIN_HINT',
    'identifierWords', 'attrBlob', 'isOtpField', 'isSearchOrComboField', 'hasStrongIdentitySignal',
    'isUsernameField', 'isPlainTextEntry', 'isLikelyUsernameInput', 'isUsernameOnlyTarget',
  ], {
    HTMLInputElement: Field, formScope, deepInputs,
    isFillable: (node) => node.isConnected && !node.disabled && !node.readOnly,
    isPasswordField: (node) => node.type === 'password',
  });
  const content = contentMessageHandler({
    ...predicates, chrome: { runtime: { id: 'extension' } }, document,
    documentToken: 'document-A', location: new URL(url), HTMLInputElement: Field,
    uiAnchor: field, fillAnchor: null, pendingFill: null, lastAutofill: null,
    deepActiveElement: () => field,
    writeField: (target, value) => { state.writes++; target.value = value; return true; },
    fillCredentials: () => { throw new Error('username-only delivery must not call fillCredentials'); },
  });
  const chrome = {
    runtime: { id: 'extension', getURL: (path) => `chrome-extension://extension/${path}` },
    storage: { local: { get: async () => ({}) } },
    tabs: {
      query: async () => [{ id: 7, url }],
      sendMessage: async (tabId, message, options) => {
        messages.push({ tabId, message, options });
        let result;
        content.listener(message, { id: 'extension' }, (value) => { result = value; });
        return result;
      },
    },
  };
  const client = {
    ready: true,
    async getLoginNamesForURL(tabId, target) {
      state.metadataReads++;
      assert.equal(tabId, 7);
      assert.equal(target, url);
      await state.duringLookup?.();
      return metadata;
    },
    async getPasswordForLoginName() {
      state.secretReads++;
      return secretAvailable ? { username, password: 'Synthetic1!' } : undefined;
    },
  };
  const shared = { chrome, client, accountKey, SITE_PREFERENCES_KEY, sitePreferencesFor,
    recordMru: () => {}, lastFillByTab: new Map([[7, { host: 'auth.uber.com', username }]]) };
  const helpers = functionsFrom('src/passwords/core/background.js', [
    'sendToPasswordContent', 'preparePasswordFill', 'fillUsernameOnly', 'isMissingReceiverError',
    'isFromOwnUi', 'isFromHmeManager', 'activeTab', 'ensurePopupTarget', 'registrableHost', 'isPasswordFillAllowed',
  ], shared);
  const background = runtimeMessageHandler('src/passwords/core/background.js', {
    ...helpers, ...shared, CONTENT_ALLOWED: new Set(['inlineFill']), ensureConnected: async () => {},
    pwCacheGet: () => null, pwCacheSet: () => {}, pwCacheClear: () => {},
  });
  const sender = kind === 'inlineFill'
    ? { id: 'extension', tab: { id: 7 }, frameId: 3, documentId: 'chrome-document-A', url }
    : { id: 'extension' };
  const request = (overrides = {}) => new Promise((resolve) => background.listener({
    type: kind, loginName: { username, sites: ['untrusted.invalid'] }, documentToken: 'document-A', ...overrides,
  }, sender, resolve));
  return { request, content, field, fields, state, messages, chrome, client };
}

for (const kind of ['inlineFill', 'fillOnPage', 'refreshAndRefill']) {
  test(`${kind}: identifier-only page fills from metadata even when no password is returned by Apple`, async () => {
    const h = harness({ kind });
    const result = await h.request();
    assert.equal(result.filled, true, result.error);
    assert.equal(result.usernameOnly, true);
    assert.equal(h.field.value, username);
    assert.equal(h.state.secretReads, 0, 'no Touch ID/password request for this step');
    assert.equal(h.state.metadataReads, 1);
    assert.equal(h.content.lastAutofill, null, 'username-only fill must not retain a password');
    assert.equal(result.detail, undefined);
    assert.equal(result.password, undefined);
    assert.equal(h.messages[1].message.type, 'fillUsername');
    assert.equal(h.messages[1].message.password, undefined);
    assert.equal(h.messages[1].message.expectedHost, 'auth.uber.com');
    assert.deepEqual({ ...h.messages[1].options }, kind === 'inlineFill' ? { documentId: 'chrome-document-A' } : { frameId: 0 });
    assert.doesNotMatch(JSON.stringify(h.messages), /Synthetic1!|untrusted/);
  });
}

test('details-only still performs the explicitly requested password read', async () => {
  const h = harness({ kind: 'fillOnPage', secretAvailable: true });
  const result = await h.request({ mode: 'details' });
  assert.equal(result.detail.password, 'Synthetic1!');
  assert.equal(h.state.secretReads, 1);
  assert.equal(h.state.metadataReads, 0);
  assert.equal(h.state.writes, 0);
  assert.equal(h.messages.length, 0);
});

test('missing secrets have an actionable reason in both toolbar and inline flows', async () => {
  for (const kind of ['inlineFill', 'fillOnPage']) {
    const h = harness({ kind });
    h.content.isUsernameOnlyTarget = () => false;
    const result = await h.request();
    assert.equal(result.filled, false);
    assert.equal(result.reason, 'saved_login_unavailable');
    assert.equal(h.state.secretReads, 1);
    assert.equal(h.state.writes, 0);
  }
});

test('metadata must still match the selected exact account', async () => {
  for (const metadata of [[], [{ username: 'other@example.test' }], [{ username: username.toUpperCase() }]]) {
    const h = harness({ metadata });
    assert.equal((await h.request()).reason, 'saved_login_unavailable');
    assert.equal(h.state.writes, 0);
    assert.equal(h.state.secretReads, 0);
  }
});

test('username-only delivery retains document, field, form, lock guards', async () => {
  for (const change of [
    (h) => { h.content.documentToken = 'document-B'; },
    (h) => { h.content.location = new URL('https://auth.uber.com/changed'); },
    (h) => { h.field.value = 'typed@example.test'; },
    (h) => { h.field.isConnected = false; },
    (h) => { h.fields.push(new Field('password')); },
    (h) => { h.client.ready = false; },
  ]) {
    const h = harness();
    h.state.duringLookup = () => change(h);
    const result = await h.request();
    assert.equal(result.filled, false);
    assert.ok(['target_changed', 'locked'].includes(result.reason), result.reason);
    assert.equal(h.state.writes, 0);
    assert.equal(h.state.secretReads, 0);
  }
  const h = harness({ kind: 'fillOnPage' });
  h.state.duringLookup = () => { h.chrome.tabs.query = async () => [{ id: 8, url }]; };
  assert.equal((await h.request()).reason, 'target_changed');
  assert.equal(h.state.writes, 0);
});

test('username-only leases are single-use and cannot deliver passwords or codes', async () => {
  const h = harness();
  await h.request();
  const delivered = h.messages[1].message;
  let response;
  h.content.listener(delivered, { id: 'extension' }, (value) => { response = value; });
  assert.equal(response.reason, 'target_changed');
  assert.equal(h.state.writes, 1);
  for (const type of ['fill', 'fillOtp']) {
    h.content.listener({ type: 'prepareFill' }, { id: 'extension' }, (value) => { response = value; });
    h.content.listener({ ...delivered, targetToken: response.targetToken, type, password: 'Synthetic1!', code: '123456' },
      { id: 'extension' }, (value) => { response = value; });
    assert.equal(response.reason, 'target_changed');
    assert.equal(h.state.writes, 1);
  }
  assert.equal(validContentFillRequest(delivered), true);
  assert.equal(validContentFillRequest({ ...delivered, password: 'secret' }), false);
});

test('diagnostics distinguish native query errors, missing logins and page transport failures', () => {
  for (const [error, expected] of [
    [new Error('Generic query error'), 'native_query_failed'],
    [new Error('Invalid query param'), 'native_query_failed'],
    [new Error('Could not establish connection. Receiving end does not exist.'), 'content_unavailable'],
    [{ reason: 'saved_login_unavailable' }, 'saved_login_unavailable'],
  ]) {
    assert.equal(failureReason(error), expected);
    assert.notEqual(failureMessage(expected, true), failureMessage('unavailable', true));
  }
});
