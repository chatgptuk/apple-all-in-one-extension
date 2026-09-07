import assert from 'node:assert/strict';
import test from 'node:test';
import { contentMessageHandler, functionsFrom, runtimeMessageHandler } from './source-harness.mjs';
import { selectAccountCode } from '../src/passwords/core/account-identity.js';

const originalUrl = 'https://console.socks5.io/login?landing_page=%2F';
const currentUrl = 'https://console.socks5.io/zh/login?landing_page=/';
const credential = { username: 'SyntheticUser', password: 'SyntheticPassword1!' };
class Input {
  isConnected = true;
  disabled = false;
  readOnly = false;
  value = '';
}

// Exercise the actual background listener, preparation and delivery functions,
// and content listener together. Only Chrome transport, DOM and Apple are mocked.
function harness({ href = currentUrl, cached = false, noInput = false } = {}) {
  const anchor = noInput ? null : new Input();
  const calls = [], lookups = [], fills = [];
  const page = { documentId: 'chrome-document-A', available: true, injections: 0 };
  const content = contentMessageHandler({
    chrome: { runtime: { id: 'extension' } },
    documentToken: 'content-document-A',
    location: new URL(href),
    HTMLInputElement: Input,
    document: { querySelectorAll: () => [] },
    deepActiveElement: () => anchor,
    uiAnchor: null, fillAnchor: null, pendingFill: null, lastAutofill: null,
    isFillable: (field) => !!field?.isConnected && !field.disabled && !field.readOnly,
    isUsernameField: () => true,
    isPasswordField: () => false,
    isOtpField: () => true,
    firstVisibleOtpField: () => null,
    fillCredentials: (username, password, target) => {
      fills.push({ type: 'fill', username, password, target });
      return true;
    },
    fillOneTimeCode: (code, target) => {
      if (!target) return false;
      fills.push({ type: 'fillOtp', code, target });
      return true;
    },
  });
  const chrome = {
    runtime: { id: 'extension', getURL: (path) => `chrome-extension://extension/${path}` },
    tabs: {
      query: async () => [{ id: 7, url: originalUrl }],
      sendMessage: async (tabId, message, options) => {
        calls.push({ tabId, message, options });
        if (!page.available || (options.documentId && options.documentId !== page.documentId))
          throw new Error('Could not establish connection. Receiving end does not exist.');
        let response;
        content.listener(message, { id: 'extension' }, (value) => { response = value; });
        return response;
      },
    },
    scripting: { executeScript: async () => { page.injections++; page.available = true; } },
  };
  const helpers = functionsFrom('src/passwords/core/background.js', [
    'sendToPasswordContent', 'preparePasswordFill', 'isMissingReceiverError',
    'isFromOwnUi', 'isFromHmeManager', 'activeTab', 'ensurePopupTarget', 'registrableHost', 'isLocalDevHost',
  ], { chrome });
  const client = {
    ready: true,
    getPasswordForLoginName: async (tabId, url, login) => {
      lookups.push({ type: 'password', tabId, url, login });
      await page.duringAuthentication?.();
      return credential;
    },
    getOneTimeCodeForURL: async (tabId, url) => {
      lookups.push({ type: 'otp', tabId, url });
      await page.duringAuthentication?.();
      return [{ username: credential.username, code: '123456', domain: 'console.socks5.io' }];
    },
  };
  const background = runtimeMessageHandler('src/passwords/core/background.js', {
    ...helpers, chrome, client,
    CONTENT_ALLOWED: new Set(['inlineFill', 'inlineFillOtp']),
    ensureConnected: async () => {},
    pwCacheGet: () => cached ? credential : null,
    pwCacheSet: () => {}, pwCacheClear: () => {}, recordMru: () => {},
    lastFillByTab: new Map([[7, { host: 'console.socks5.io', username: credential.username }]]),
    selectAccountCode,
  });
  const sender = {
    id: 'extension', tab: { id: 7 }, url: originalUrl,
    frameId: 3, documentId: page.documentId,
  };
  const request = (type = 'inlineFill', overrides = {}, from = sender) => new Promise((resolve) => {
    background.listener({
      type, loginName: { username: credential.username, sites: ['untrusted.invalid'] },
      username: credential.username, documentToken: 'content-document-A', ...overrides,
    }, from, resolve);
  });
  return { anchor, content, calls, lookups, fills, page, chrome, helpers, sender, request };
}

for (const type of ['fillOnPage', 'fillOtpOnPage']) {
  test(`${type}: details-only never prepares or fills a webpage`, async () => {
    const h = harness();
    const result = await h.request(type, { mode: 'details' }, { id: 'extension' });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.filled, false);
    assert.ok(result.detail);
    assert.equal(h.lookups.length, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(h.fills.length, 0);
  });
  test(`${type}: changing tabs during a details read discards the result`, async () => {
    const h = harness();
    h.page.duringAuthentication = () => { h.chrome.tabs.query = async () => [{ id: 8, url: originalUrl }]; };
    const result = await h.request(type, { mode: 'details' }, { id: 'extension' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'target_changed');
    assert.equal(result.detail, undefined);
    assert.equal(h.fills.length, 0);
  });
}

test('the standalone HME manager cannot request password reads or inline filling', async () => {
  const h = harness();
  for (const tab of [undefined, { id: 9 }]) {
    for (const type of ['fillOnPage', 'inlineFill', 'fillOtpOnPage', 'connect']) {
      const result = await h.request(type, {}, { id: 'extension', tab, url: 'chrome-extension://extension/popup.html?manager=1' });
      assert.equal(result.ok, false);
    }
  }
  assert.equal(h.lookups.length, 0);
});

for (const type of ['inlineFill', 'inlineFillOtp', 'fillOnPage', 'fillOtpOnPage', 'refreshAndRefill']) {
  test(`${type}: same-document locale rewrite uses current URL and fills the bound field`, async () => {
    const h = harness();
    const inline = type.startsWith('inline');
    const result = await h.request(type, {}, inline ? h.sender : { id: 'extension' });
    assert.equal(result.filled ?? result.refilled, true, result.error);
    assert.equal(h.lookups.length, 1);
    assert.equal(h.lookups[0].url, currentUrl);
    assert.equal(h.fills[0].target, h.anchor);
    assert.equal(h.calls[0].message.expectedHref, undefined, 'stale sender href is not a preparation guard');
    assert.equal(h.calls[1].message.expectedHref, currentUrl, 'delivery is bound to the current snapshot');
    for (const call of h.calls) {
      assert.equal(call.tabId, 7);
      assert.deepEqual(JSON.parse(JSON.stringify(call.options)), inline ? { documentId: h.sender.documentId } : { frameId: 0 });
    }
    if (inline) {
      assert.equal(result.password, undefined);
      assert.equal(result.code, undefined);
      assert.equal(result.detail, undefined, 'never return secrets to inline callers');
    }
    if (type === 'inlineFill') assert.deepEqual(Object.keys(h.lookups[0].login), ['username']);
  });
}

test('query escaping changes before preparation and cached password reads remain fillable', async () => {
  const h = harness({ href: 'https://console.socks5.io/login?landing_page=/', cached: true });
  assert.equal((await h.request()).filled, true);
  assert.equal(h.lookups.length, 0);
  assert.equal(h.fills.length, 1);
});

test('preparation rejects different origins, documents and legacy inline callers before reading secrets', async () => {
  for (const href of ['http://console.socks5.io/login', 'https://console.socks5.io:444/login', 'https://other.socks5.io/login']) {
    const h = harness({ href });
    assert.equal((await h.request()).ok, false);
    assert.equal(h.lookups.length, 0);
    assert.equal(h.fills.length, 0);
  }
  for (const documentIdAvailable of [true, false]) {
    const h = harness();
    if (!documentIdAvailable) delete h.sender.documentId;
    h.page.documentId = 'chrome-document-B';
    h.content.documentToken = 'content-document-B';
    assert.equal((await h.request()).ok, false);
    assert.equal(h.lookups.length, 0);
    assert.equal(h.page.injections, 0, 'never inject into a replacement inline document');
  }
  for (const type of ['inlineFill', 'inlineFillOtp']) {
    const h = harness();
    assert.equal((await h.request(type, { documentToken: undefined })).ok, false);
    assert.equal(h.lookups.length, 0);
  }
});

test('inline preparation works without Chrome documentId but still binds the content document', async () => {
  const h = harness();
  delete h.sender.documentId;
  assert.equal((await h.request()).filled, true);
  assert.equal(h.calls[0].options.frameId, 3);
  assert.equal(h.calls[0].message.expectedDocumentToken, 'content-document-A');
});

test('background rejects malformed, legacy and wrong-origin preparation responses', async () => {
  for (const patch of [
    { href: undefined }, { href: '/relative/login' }, { href: 'not a URL' },
    { href: 'https://untrusted.invalid/login' }, { documentToken: '' },
    { documentToken: 'content-document-B' }, { targetToken: '' }, { ok: false },
  ]) {
    const h = harness();
    h.chrome.tabs.sendMessage = async () => ({
      ok: true, href: currentUrl, documentToken: 'content-document-A', targetToken: 'target-A', ...patch,
    });
    await assert.rejects(h.helpers.preparePasswordFill(7, originalUrl, 3, 'chrome-document-A', 'content-document-A'), /sign-in page changed/);
  }
});

test('real changes during authentication still block password and OTP delivery', async () => {
  const changes = [
    (h) => { h.content.location.href = 'https://console.socks5.io/other'; },
    (h) => { h.content.location.href = 'https://untrusted.invalid/login'; },
    (h) => { h.content.documentToken = 'content-document-B'; },
    (h) => { h.page.documentId = 'chrome-document-B'; },
    (h) => { h.anchor.isConnected = false; },
    (h) => { h.anchor.disabled = true; },
    (h) => { h.anchor.value = 'user-edited'; },
    (h) => { h.content.pendingFill = null; },
    (h) => { h.content.pendingFill.at -= 91_000; },
  ];
  for (const type of ['inlineFill', 'inlineFillOtp']) {
    for (const change of changes) {
      const h = harness();
      h.page.duringAuthentication = () => change(h);
      assert.notEqual((await h.request(type)).filled, true);
      assert.equal(h.fills.length, 0);
      assert.equal(h.page.injections, 0);
    }
  }
});

test('delivery leases remain one-use and superseded preparations cannot fill', async () => {
  const h = harness();
  const prepare = () => h.helpers.preparePasswordFill(7, originalUrl, 3, h.sender.documentId, 'content-document-A');
  const first = await prepare(), second = await prepare();
  const fill = (binding) => h.helpers.sendToPasswordContent(7, { type: 'fill', ...credential }, 3, binding);
  assert.equal((await fill(first)).filled, false);
  assert.equal((await fill(second)).filled, true);
  assert.equal((await fill(second)).filled, false);
  assert.equal(h.fills.length, 1);
});

test('toolbar can recover a missing receiver before preparation, never after authentication', async () => {
  const h = harness();
  h.page.available = false;
  assert.equal((await h.request('fillOnPage', {}, { id: 'extension' })).filled, true);
  assert.equal(h.page.injections, 1);
  const changed = harness();
  changed.page.duringAuthentication = () => { changed.page.available = false; };
  assert.notEqual((await changed.request('fillOnPage', {}, { id: 'extension' })).filled, true);
  assert.equal(changed.page.injections, 0);
  assert.equal(changed.fills.length, 0);
});

test('toolbar details still open when no compatible login field exists', async () => {
  const h = harness({ noInput: true });
  const result = await h.request('fillOnPage', {}, { id: 'extension' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.filled, false);
  assert.equal(result.reason, 'no_login_field');
  assert.equal(result.detail.password, credential.password);
  assert.equal(h.fills.length, 0);
});
