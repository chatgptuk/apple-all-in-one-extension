import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplePasswords, Command, State } from '../src/passwords/core/protocol.js';
import { failureReason, failureMessage } from '../src/passwords/message-contracts.js';
import { deferred } from './source-harness.mjs';

function unlockedClient(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  const client = new ApplePasswords();
  const port = { sent: [], closed: false,
    postMessage(message) { this.sent.push(message); },
    disconnect() { this.closed = true; },
  };
  client.port = port;
  client.session = { sharedKey: new Uint8Array(32) };
  client.state = State.Unlocked;
  t.after(() => client.disconnect());
  return { client, port };
}

for (const cmd of [Command.GET_LOGIN_NAMES_FOR_URL, Command.GET_ONE_TIME_CODES]) {
  test(`slow metadata cmd ${cmd} preserves SRP and drains stale data before accepting another request`, async (t) => {
    const { client, port } = unlockedClient(t);
    const session = client.session;
    const pending = assert.rejects(client._send(cmd, {}, 5000), /timeout/);
    t.mock.timers.tick(5000);
    await pending;
    assert.equal(client.ready, true);
    assert.equal(client.session, session);
    assert.equal(port.closed, false);
    assert.equal(client._waiters.get(cmd).draining, true);
    assert.equal(client.getDiagnostics().events.at(-1).reason, 'metadata_slow');
    // Both same-command retries and different commands are held off. No late
    // reply can be confused with a new account's query or cause an extra Touch ID.
    for (const next of [cmd, Command.GET_PASSWORD_FOR_LOGIN_NAME, Command.HANDSHAKE]) {
      await assert.rejects(client._send(next), /busy/);
    }
    assert.equal(port.sent.length, 1);
    client._dispatch({ cmd: Command.GET_CAPABILITIES, payload: 'unrelated' }, port);
    assert.equal(client._waiters.size, 1);
    t.mock.timers.tick(10_000);
    client._dispatch({ cmd, payload: 'stale-sensitive-metadata' }, port);
    assert.equal(client._waiters.size, 0);
    assert.equal(client.getDiagnostics().events.at(-1).reason, 'metadata_drained');
    t.mock.timers.tick(30_000);
    assert.equal(client.ready, true, 'draining cancels the hard deadline');
    assert.equal(client.session, session);
    const fresh = client._send(cmd);
    client._dispatch({ cmd, payload: 'fresh-result' }, port);
    assert.equal((await fresh).payload, 'fresh-result');
    assert.doesNotMatch(JSON.stringify(client.getDiagnostics()), /stale-sensitive|fresh-result/);
  });
}

test('a permanently stuck metadata reply ends the connection after a bounded grace period', async (t) => {
  const { client, port } = unlockedClient(t);
  const rejected = assert.rejects(client._send(Command.GET_LOGIN_NAMES_FOR_URL), /timeout/);
  t.mock.timers.tick(5000);
  await rejected;
  t.mock.timers.tick(24_999);
  assert.equal(client.ready, true);
  t.mock.timers.tick(1);
  assert.equal(client.state, State.Disconnected);
  assert.equal(client.session, undefined);
  assert.equal(client._waiters.size, 0);
  assert.equal(port.closed, true);
  assert.equal(client.getDiagnostics().events.at(-1).reason, 'response_timeout');
  const replacement = { postMessage() {}, disconnect() {} };
  client.port = replacement;
  const next = client._send(Command.GET_LOGIN_NAMES_FOR_URL);
  client._dispatch({ cmd: Command.GET_LOGIN_NAMES_FOR_URL, payload: 'old' }, port);
  assert.equal(client._waiters.size, 1);
  client._dispatch({ cmd: Command.GET_LOGIN_NAMES_FOR_URL, payload: 'new' }, replacement);
  assert.equal((await next).payload, 'new');
});

test('secret-read timeouts receive no metadata grace or automatic replay', async (t) => {
  const { client, port } = unlockedClient(t);
  const pending = assert.rejects(client._send(Command.GET_PASSWORD_FOR_LOGIN_NAME, {}, 60_000), /timeout/);
  t.mock.timers.tick(59_999);
  assert.equal(client.ready, true);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(client.state, State.Disconnected);
  assert.equal(port.sent.length, 1);
  assert.equal(client._waiters.size, 0);
  assert.equal(client.getDiagnostics().events.at(-1).command, Command.GET_PASSWORD_FOR_LOGIN_NAME);
});

test('handshake timeout still retires its port without metadata grace', async (t) => {
  const { client, port } = unlockedClient(t);
  const pending = assert.rejects(client._send(Command.HANDSHAKE), /timeout/);
  t.mock.timers.tick(5000);
  await pending;
  assert.equal(client.state, State.Disconnected);
  assert.equal(port.closed, true);
  assert.equal(client._waiters.size, 0);
});

test('a draining reply blocks a fresh challenge and save before they reset keys or invoke Apple UI', async (t) => {
  const { client, port } = unlockedClient(t);
  const session = client.session;
  const key = session.sharedKey;
  const pending = assert.rejects(client._send(Command.GET_LOGIN_NAMES_FOR_URL), /timeout/);
  t.mock.timers.tick(5000);
  await pending;
  await assert.rejects(client.requestChallenge(), /busy/);
  await assert.rejects(client.saveLogin(1, 'https://example.test', 'synthetic', 'synthetic'), /busy/);
  assert.equal(client.session, session);
  assert.equal(session.sharedKey, key);
  assert.equal(client.ready, true);
  assert.equal(port.sent.length, 1);
});

test('explicit Apple relogin events end even a draining session immediately', async (t) => {
  const { client, port } = unlockedClient(t);
  const pending = assert.rejects(client._send(Command.GET_ONE_TIME_CODES), /timeout/);
  t.mock.timers.tick(5000);
  await pending;
  client._dispatch({ cmd: Command.RELOGIN_NEEDED }, port);
  assert.equal(client.state, State.Disconnected);
  assert.equal(client.session, undefined);
  assert.equal(client.getDiagnostics().events.at(-1).reason, 'relogin_required');
  const count = client.getDiagnostics().events.length;
  t.mock.timers.tick(30_000);
  assert.equal(client.getDiagnostics().events.length, count);
});

test('an authenticated invalid-session response is not treated as an empty vault or a generic error', async (t) => {
  const { client } = unlockedClient(t);
  client.session = { sharedKey: 'synthetic', username: 'synthetic-session',
    encrypt: async () => 'encrypted', serialize: (x) => x, deserialize: (x) => x,
    decrypt: async () => new TextEncoder().encode(JSON.stringify({ STATUS: 9 })),
  };
  client._send = async () => ({ payload: { SMSG: { TID: 'synthetic-session', SDATA: 'synthetic-data' } } });
  await assert.rejects(client._encryptedQuery(Command.GET_LOGIN_NAMES_FOR_URL, 1, 'example.test', {}), /session expired/);
  assert.equal(client.state, State.Disconnected);
  assert.equal(client.session, undefined);
  assert.equal(client.getDiagnostics().events.at(-1).reason, 'session_expired');
  assert.equal(failureReason(new Error('Apple Passwords session expired')), 'locked');
  assert.match(failureMessage('locked', true), /解锁/);
});

test('a queued if-needed challenge cannot reset a session another UI already unlocked', async (t) => {
  const { client, port } = unlockedClient(t);
  const queue = deferred();
  client._lock = queue.promise;
  client.state = State.NeedsPin;
  client.session.sharedKey = undefined;
  const pending = client.requestChallenge({ ifNeeded: true });
  client.session.sharedKey = 'synthetic-unlocked-key';
  client._setState(State.Unlocked);
  queue.resolve();
  assert.equal(await pending, false);
  assert.equal(client.ready, true);
  assert.equal(port.sent.length, 0);
});

test('a challenge queued for a retired session cannot reset its replacement', async (t) => {
  const { client, port } = unlockedClient(t);
  const queue = deferred();
  client._lock = queue.promise;
  client.state = State.NeedsPin;
  const pending = assert.rejects(client.requestChallenge(), /session changed/);
  const replacement = { sharedKey: 'new-key' };
  client.session = replacement;
  client.state = State.Unlocked;
  queue.resolve();
  await pending;
  assert.equal(client.session, replacement);
  assert.equal(client.ready, true);
  assert.equal(port.sent.length, 0);
});

test('native diagnostics are bounded, detached copies with no raw input retention', async (t) => {
  const { client } = unlockedClient(t);
  client._recordNativeEvent('private password or error https://example.test', 'secret');
  assert.equal(client.getDiagnostics().events.length, 0);
  for (let i = 0; i < 30; i++) client._recordNativeEvent('metadata_slow', 'private-url');
  const report = client.getDiagnostics();
  assert.equal(report.events.length, 20);
  assert.equal(report.startedAt, 100_000);
  assert.doesNotMatch(JSON.stringify(report), /private|secret|example/);
  report.events[0].reason = 'mutated';
  assert.equal(client.getDiagnostics().events[0].reason, 'metadata_slow');
});
