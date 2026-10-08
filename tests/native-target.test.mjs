import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNativeTarget } from '../src/passwords/core/native-target.js';
import { ApplePasswords, Command, State } from '../src/passwords/core/protocol.js';
import { functionsFrom, runtimeMessageHandler } from './source-harness.mjs';

test('native targets normalize ordinary HTTP and HTTPS websites without restricting HTTP filling', () => {
  const targets = [
    ['https://EXAMPLE.test/login?next=%2F#form', 'example.test', 'https://example.test/login?next=%2F#form'],
    ['http://example.test:8080/login', 'example.test', 'http://example.test:8080/login'],
    ['https://example.test:443', 'example.test', 'https://example.test/'],
    ['http://192.0.2.1:8080/login', '192.0.2.1', 'http://192.0.2.1:8080/login'],
    ['http://[2001:db8::1]:8080/login', '[2001:db8::1]', 'http://[2001:db8::1]:8080/login'],
    ['http://localhost:4179', 'localhost', 'http://localhost:4179/'],
    ['https://例子.测试/login', 'xn--fsqu00a.xn--0zwm56d', 'https://xn--fsqu00a.xn--0zwm56d/login'],
  ];
  for (const tabId of [0, 1, 2147483647]) {
    for (const [url, hostname, href] of targets) {
      assert.deepEqual(normalizeNativeTarget(tabId, url), { hostname, href });
    }
  }
});

test('native targets reject browser-internal, local-file and opaque document URLs', () => {
  for (const url of [
    'chrome://newtab/',
    'chrome://settings/',
    'chrome-extension://synthetic/popup.html',
    'edge://newtab/',
    'about:blank',
    'about:srcdoc',
    'file:///tmp/synthetic-login.html',
    'blob:https://example.test/synthetic-document',
    'data:text/html,synthetic',
    'javascript:void(0)',
    'ftp://example.test/login',
    'ws://example.test/',
    'wss://example.test/',
  ]) {
    assert.throws(() => normalizeNativeTarget(1, url), {
      message: 'Apple Passwords is unavailable on this page',
      code: 'unsupported_page',
    });
  }
});

test('native targets reject missing or malformed URLs with the same stable error', () => {
  for (const url of [
    undefined, null, false, 12, {}, [], new URL('https://example.test'),
    '', '   ', 'example.test', '/login', 'https://', 'http:///',
    'https://?query', 'https://#fragment', 'https://exa mple.test',
    'http://[invalid]/', 'http://example.test:99999/',
  ]) {
    assert.throws(() => normalizeNativeTarget(1, url), {
      message: 'Apple Passwords is unavailable on this page',
      code: 'unsupported_page',
    });
  }
});

test('native targets require a nonnegative integer browser tab ID', () => {
  for (const tabId of [-1, -2, 1.5, NaN, Infinity, -Infinity, undefined, null, true, '1', {}, []]) {
    assert.throws(() => normalizeNativeTarget(tabId, 'https://example.test/login'), {
      message: 'Apple Passwords is unavailable on this page',
      code: 'unsupported_page',
    });
  }
});

// Exercise the real protocol boundary without starting a native process. The
// synthetic session intentionally uses JSON instead of real credentials/keys.
function protocolHarness() {
  const client = new ApplePasswords();
  const sent = [];
  const encrypted = [];
  const session = {
    username: 'synthetic-session',
    sharedKey: 1,
    encrypt: async (payload) => { encrypted.push(payload); return JSON.stringify(payload); },
    serialize: (value) => value,
    deserialize: (value) => value,
    decrypt: async (value) => new TextEncoder().encode(value),
  };
  const port = {
    postMessage(message) {
      sent.push(message);
      if (message.cmd === Command.SET_PASSWORD_FOR_LOGIN_NAME_URL) return;
      const query = JSON.parse(JSON.parse(message.payload.SMSG).SDATA);
      const entries = message.cmd === Command.GET_LOGIN_NAMES_FOR_URL || message.cmd === Command.GET_PASSWORD_FOR_LOGIN_NAME
        ? [{ USR: 'synthetic-user', PWD: 'SyntheticPassword', sites: [query.URL] }]
        : [{ username: 'synthetic-user', domain: 'example.test', source: 'totp', code: '123456' }];
      queueMicrotask(() => client._dispatch({
        cmd: message.cmd,
        payload: { SMSG: { TID: session.username, SDATA: JSON.stringify({ STATUS: 0, Entries: entries }) } },
      }, port));
    },
  };
  client.port = port;
  client.session = session;
  client.state = State.Unlocked;
  return { client, port, session, sent, encrypted };
}

const nativeOperations = [
  (client, tabId, url) => client.getLoginNamesForURL(tabId, url),
  (client, tabId, url) => client.getPasswordForLoginName(tabId, url, { username: 'synthetic-user' }),
  (client, tabId, url) => client.listOneTimeCodesForURL(tabId, url),
  (client, tabId, url) => client.getOneTimeCodeForURL(tabId, url),
  (client, tabId, url) => client.saveLogin(tabId, url, 'synthetic-user', 'SyntheticPassword'),
];

test('every public website protocol operation rejects unsupported targets before encryption or native sends', async () => {
  const targets = [
    [1, 'chrome://newtab/'],
    [1, 'about:blank'],
    [1, 'file:///tmp/synthetic.html'],
    [1, 'blob:https://example.test/synthetic'],
    [1, 'data:text/html,synthetic'],
    [1, 'chrome-extension://synthetic/popup.html'],
    [1, 'https://'],
    [1, ''],
    [-1, 'https://example.test'],
    [undefined, 'https://example.test'],
  ];
  const h = protocolHarness();
  const originalLock = h.client._lock;
  for (const operation of nativeOperations) {
    for (const [tabId, url] of targets) {
      await assert.rejects(operation(h.client, tabId, url), { code: 'unsupported_page' });
      assert.equal(h.client.ready, true, 'rejecting a page must not lock the session');
      assert.equal(h.client.session, h.session);
      assert.equal(h.client.port, h.port);
      assert.equal(h.client._lock, originalLock, 'invalid requests never enter the native queue');
      assert.equal(h.client._waiters.size, 0);
    }
  }
  assert.equal(h.encrypted.length, 0);
  assert.equal(h.sent.length, 0);
});

test('HTTP and HTTPS website operations preserve normalized hostname and absolute OTP wire formats', async () => {
  for (const url of ['https://EXAMPLE.test:443/login?next=%2F#form', 'http://192.0.2.1:8080/login']) {
    const h = protocolHarness();
    const target = new URL(url);
    for (const operation of nativeOperations) await operation(h.client, 0, url);
    assert.deepEqual(h.sent.map((message) => message.cmd), [4, 5, 16, 17, 6]);
    assert.ok(h.sent.every((message) => message.tabId === 0));
    for (const index of [0, 1]) {
      assert.equal(h.sent[index].url, target.hostname);
      assert.equal(h.encrypted[index].URL, target.hostname);
    }
    for (const index of [2, 3]) {
      assert.equal('url' in h.sent[index], false, 'OTP URLs belong only in the encrypted payload');
      assert.deepEqual(h.encrypted[index].frameURLs, [target.href]);
      assert.equal(h.encrypted[index].TYPE, 'oneTimeCodes');
    }
    assert.equal(h.encrypted[4].NURL, target.hostname);
    assert.equal(h.client.ready, true);
  }
});

test('low-level password queries reject missing, empty and mismatched domain payloads before encryption', async () => {
  const h = protocolHarness();
  for (const cmd of [Command.GET_LOGIN_NAMES_FOR_URL, Command.GET_PASSWORD_FOR_LOGIN_NAME]) {
    for (const payload of [undefined, {}, { ACT: 5 }, { URL: undefined }, { URL: null }, { URL: '' }, { URL: ' ' }, { URL: 123 }, { URL: 'other.example.test' }]) {
      await assert.rejects(h.client._encryptedQuery(cmd, 1, 'example.test', payload, 5000), { code: 'unsupported_page' });
      assert.equal(h.client.ready, true);
      assert.equal(h.client.session, h.session);
      assert.equal(h.client.port, h.port);
    }
  }
  assert.equal(h.encrypted.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.client._waiters.size, 0);
});

function backgroundHarness(url, state = State.Disconnected) {
  const path = 'src/passwords/core/background.js';
  const calls = { connect: 0, logins: 0, otp: 0 };
  const tab = { id: 1, url };
  const chrome = {
    runtime: { id: 'synthetic-target-test', getURL: (part) => `chrome-extension://synthetic-target-test/${part}` },
    tabs: { query: async () => [tab] },
  };
  const client = {
    state,
    ready: state === State.Unlocked,
    getLoginNamesForURL: async () => { calls.logins += 1; return []; },
    listOneTimeCodesForURL: async () => { calls.otp += 1; return []; },
  };
  const helpers = functionsFrom(path, ['isFromOwnUi', 'isFromHmeManager', 'activeTab', 'registrableHost'], { chrome });
  const { listener } = runtimeMessageHandler(path, {
    ...helpers,
    client,
    chrome,
    State,
    normalizeNativeTarget,
    CONTENT_ALLOWED: new Set(['inlineLogins', 'inlineOtpItems']),
    ensureConnected: async () => { calls.connect += 1; },
    uniqueByUsername: (entries) => entries,
    describeLoginCandidatesForHost: (_host, entries) => entries,
    orderForHost: (_host, entries) => entries,
  });
  const request = (type) => {
    const sender = type.startsWith('inline')
      ? { id: chrome.runtime.id, url, tab, frameId: 0 }
      : { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
    return new Promise((resolve) => listener({ type }, sender, resolve));
  };
  return { client, calls, request };
}

const metadataOperations = ['inlineLogins', 'inlineOtpItems', 'getLogins', 'getOtpItems'];

test('actual background metadata handlers reject unsupported pages before native connection or lookup', async () => {
  for (const url of ['chrome://newtab/', 'about:blank', 'file:///tmp/synthetic.html', 'blob:https://example.test/synthetic', 'data:text/html,synthetic', 'https://']) {
    for (const state of [State.Disconnected, State.Unlocked]) {
      const h = backgroundHarness(url, state);
      for (const operation of metadataOperations) {
        const response = await h.request(operation);
        assert.equal(response.ok, false, `${operation}: ${url}`);
        assert.equal(response.reason, 'unsupported_page', `${operation}: ${url}`);
        assert.notEqual(response.locked, true);
        assert.equal(h.client.state, state);
      }
      assert.deepEqual(h.calls, { connect: 0, logins: 0, otp: 0 });
    }
  }
});

test('actual background metadata handlers still query normal HTTP and HTTPS websites', async () => {
  for (const url of ['https://example.test/login', 'http://192.0.2.1:8080/login']) {
    const h = backgroundHarness(url, State.Unlocked);
    for (const operation of metadataOperations) {
      const response = await h.request(operation);
      assert.equal(response.ok, true, operation);
      assert.notEqual(response.reason, 'unsupported_page');
      assert.notEqual(response.locked, true);
    }
    assert.deepEqual(h.calls, { connect: 4, logins: 2, otp: 2 });
  }
});
