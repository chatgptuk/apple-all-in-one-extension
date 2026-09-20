import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplePasswords, Command, State } from '../src/passwords/core/protocol.js';
import { functionsFrom, runtimeMessageHandler } from './source-harness.mjs';

const background = 'src/passwords/core/background.js';

// Exercise the real native client without launching Apple's helper or reading secrets.
function nativeHarness(t, attempts = []) {
  const previousChrome = globalThis.chrome;
  const ports = [];
  let connections = 0;
  const chrome = {
    runtime: {
      id: 'native-reconnect-test',
      getManifest: () => ({ version: 'test' }),
      getURL: (path) => `chrome-extension://native-reconnect-test/${path}`,
      connectNative(name) {
        assert.equal(name, 'com.apple.passwordmanager');
        const attempt = attempts[connections++] || {};
        if (attempt.throw) throw new Error(attempt.throw);
        const messages = [], disconnects = [];
        const port = {
          sent: [],
          closed: false,
          onMessage: { addListener: (fn) => messages.push(fn) },
          onDisconnect: { addListener: (fn) => disconnects.push(fn) },
          postMessage(message) {
            port.sent.push(message);
            if (message.cmd === Command.GET_CAPABILITIES && !attempt.silent) {
              queueMicrotask(() => {
                if (attempt.error) port.drop(attempt.error);
                else port.reply({ cmd: message.cmd, capabilities: attempt.capabilities || {} });
              });
            }
          },
          reply(message) { for (const fn of messages) fn(message); },
          disconnect() { port.closed = true; },
          drop(message) {
            chrome.runtime.lastError = message ? { message } : undefined;
            try { for (const fn of disconnects) fn(); }
            finally { chrome.runtime.lastError = undefined; }
          },
        };
        ports.push(port);
        return port;
      },
    },
    storage: { local: { get: async () => ({}) } },
  };
  globalThis.chrome = chrome;
  const client = new ApplePasswords();
  t.after(() => { client.disconnect(); globalThis.chrome = previousChrome; });
  const helpers = functionsFrom(background, ['ensureConnected', 'isFromOwnUi', 'isFromHmeManager'], { client, State, chrome });
  const { listener } = runtimeMessageHandler(background, {
    client, State, chrome,
    ensureConnected: helpers.ensureConnected,
    isFromOwnUi: helpers.isFromOwnUi,
    isFromHmeManager: helpers.isFromHmeManager,
    CONTENT_ALLOWED: new Set(),
    activeTab: async () => ({ id: 1 }),
    saveStatusByTab: new Map(),
    pendingSaves: { size: 0 },
    recentDiagnosticEvents: [],
    nativeDiagnosticJournal: { read: async () => [] },
  });
  const sender = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
  const request = (type, from = sender) => new Promise((resolve) => listener({ type }, from, resolve));
  return { client, chrome, ports, request, ensureConnected: helpers.ensureConnected, connections: () => connections };
}

test('temporary native host exits clear session state and reconnect without reloading', async (t) => {
  const h = nativeHarness(t);
  for (const message of [
    'Native host has exited.',
    'Error when communicating with the native messaging host.',
    'Failed to start native messaging host.',
    'Unknown connection failure',
    undefined,
  ]) {
    await h.ensureConnected();
    const port = h.client.port;
    // Synthetic unlocked state: no real secret is requested or placed in the mock.
    h.client.session.sharedKey = new Uint8Array(32);
    h.client._setState(State.Unlocked);
    assert.equal(h.client.ready, true);
    port.drop(message);
    assert.equal(h.client.state, State.Disconnected, message);
    assert.equal(h.client.port, undefined);
    assert.equal(h.client.session, undefined);
    assert.equal(h.client.capabilities, undefined);
    assert.equal(h.client.hasChallenge, false);
    assert.equal(port.closed, true);
    const count = h.connections();
    await Promise.resolve();
    assert.equal(h.connections(), count, 'no background reconnect loop');
    const result = await h.request('connect');
    assert.equal(result.ok, true);
    assert.equal(result.state, State.NeedsPin, 'reconnect never bypasses unlock');
    assert.equal(result.hasChallenge, false);
    assert.equal(h.connections(), count + 1);
    assert.equal(h.client.ready, false);
    assert.deepEqual(h.client.port.sent.map((m) => m.cmd), [Command.GET_CAPABILITIES]);
  }
});

test('missing or forbidden helper can be retried explicitly, not by passive page lookups', async (t) => {
  const errors = [
    'Specified native messaging host not found.',
    'Access to the specified native messaging host is forbidden.',
    'Native messaging host com.apple.passwordmanager is not registered.',
    'Invalid native messaging host name specified.',
  ];
  const h = nativeHarness(t, errors.flatMap((error) => [{ error }, {}]));
  for (const message of errors) {
    h.client.disconnect();
    const failure = await h.request('connect');
    assert.equal(failure.ok, false, 'connect must not report success after failure');
    assert.equal(failure.state, State.NoHelper, message);
    const count = h.connections();
    await h.ensureConnected();
    await h.ensureConnected();
    assert.equal(h.connections(), count);
    const recovered = await h.request('connect');
    assert.equal(recovered.ok, true);
    assert.equal(recovered.state, State.NeedsPin);
    assert.equal(h.connections(), count + 1);
  }
});

test('synchronous native connection failures use the same classification and recover', async (t) => {
  const h = nativeHarness(t, [
    { throw: 'Native host has exited.' }, {},
    { throw: 'Specified native messaging host not found.' }, {},
  ]);
  assert.equal((await h.request('connect')).state, State.Disconnected);
  assert.equal((await h.request('connect')).ok, true);
  h.client.disconnect();
  assert.equal((await h.request('connect')).state, State.NoHelper);
  assert.equal((await h.request('connect')).state, State.NeedsPin);
  assert.equal(h.connections(), 4);
});

test('concurrent retries share one connection and never reset an unlocked session', async (t) => {
  const h = nativeHarness(t, [{ silent: true }]);
  h.client._setState(State.NoHelper);
  const requests = [h.request('connect'), h.request('connect'), h.request('connect')];
  assert.equal(h.connections(), 1);
  h.ports[0].reply({ cmd: Command.GET_CAPABILITIES, capabilities: {} });
  assert.ok((await Promise.all(requests)).every((r) => r.ok && r.state === State.NeedsPin));
  const session = h.client.session;
  session.sharedKey = new Uint8Array(32);
  h.client._setState(State.Unlocked);
  assert.equal((await h.request('connect')).state, State.Unlocked);
  assert.equal(h.client.session, session);
  assert.equal(h.connections(), 1);
});

test('capability timeout retires the port and ignores late old-port events after retry', async (t) => {
  const h = nativeHarness(t, [{ silent: true }, {}]);
  const send = h.client._send.bind(h.client);
  h.client._send = (cmd, body) => send(cmd, body, 20);
  assert.equal((await h.request('connect')).ok, false);
  assert.equal(h.client.state, State.Disconnected);
  assert.equal(h.client.port, undefined);
  assert.equal(h.ports[0].closed, true);
  assert.equal(h.client._waiters.size, 0);
  assert.equal((await h.request('connect')).ok, true);
  const session = h.client.session;
  h.ports[0].drop('Specified native messaging host not found.');
  h.ports[0].reply({ cmd: Command.GET_CAPABILITIES, capabilities: { secretSessionVersion: -1 } });
  assert.equal(h.client.port, h.ports[1]);
  assert.equal(h.client.session, session);
  assert.equal(h.client.state, State.NeedsPin);
});

test('unsupported authentication capabilities still fail closed but permit a healthy retry', async (t) => {
  const h = nativeHarness(t, [{ capabilities: { secretSessionVersion: -1 } }, {}]);
  const failure = await h.request('connect');
  assert.equal(failure.ok, false);
  assert.equal(failure.state, State.NoHelper);
  assert.equal(h.client.session, undefined);
  assert.equal(h.client.port, undefined);
  assert.equal(h.ports[0].closed, true);
  assert.equal((await h.request('connect')).state, State.NeedsPin);
  assert.equal(h.client.ready, false);
});

test('state reads and unprivileged connect messages cannot start native recovery', async (t) => {
  const h = nativeHarness(t);
  h.client._setState(State.NoHelper);
  assert.equal((await h.request('getState')).state, State.NoHelper);
  assert.equal(h.connections(), 0);
  for (const sender of [
    { id: h.chrome.runtime.id, url: 'https://example.test', tab: { id: 1 }, frameId: 0 },
    { id: h.chrome.runtime.id, url: h.chrome.runtime.getURL('popup.html?manager=1') },
    { id: 'unrelated-extension' },
  ]) {
    assert.equal((await h.request('connect', sender)).ok, false);
  }
  assert.equal(h.connections(), 0);
  assert.equal((await h.request('connect')).state, State.NeedsPin);
});

test('the actual diagnostic response includes sanitized native lifecycle events', async (t) => {
  const h = nativeHarness(t);
  await h.request('connect');
  h.client.port.drop('Native host has exited. private diagnostic data');
  const result = await h.request('getDiagnostics');
  assert.equal(result.ok, true);
  assert.equal(result.report.passwordState, State.Disconnected);
  assert.equal(result.report.nativeConnection.events.at(-1).reason, 'helper_exited');
  assert.equal(typeof result.report.nativeConnection.startedAt, 'number');
  assert.doesNotMatch(JSON.stringify(result.report), /private diagnostic|native-reconnect-test/);
});
