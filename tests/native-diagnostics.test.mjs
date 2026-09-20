import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeDiagnosticJournal } from '../src/passwords/core/native-diagnostics.js';
import { ApplePasswords, Command } from '../src/passwords/core/protocol.js';
import { deferred } from './source-harness.mjs';

test('a new worker preserves lifecycle evidence but never restores authentication', async () => {
  let data = {};
  const storage = { get: async () => structuredClone(data), set: async (next) => { data = structuredClone(next); } };
  const first = createNativeDiagnosticJournal(storage);
  const client = new ApplePasswords({ onDiagnosticEvent: first.record });
  client._recordNativeEvent('unlocked');
  client._recordNativeEvent('helper_exited');
  await first.read();
  const second = createNativeDiagnosticJournal(storage);
  assert.deepEqual((await second.read()).map((event) => event.reason), ['worker_started', 'unlocked', 'helper_exited', 'worker_started']);
  const fresh = new ApplePasswords({ onDiagnosticEvent: second.record });
  assert.equal(fresh.ready, false);
  assert.equal(fresh.session, undefined);
});

test('journal sanitizes both stored and incoming events and bounds its detached history', async () => {
  const writes = [];
  const journal = createNativeDiagnosticJournal({
    get: async () => ({ passwordNativeDiagnosticHistory: [
      { reason: 'helper_exited', at: 100, password: 'private-secret', url: 'https://example.test' },
      { reason: 'private error message', at: 101 },
      { reason: 'worker_started', at: 'private string' },
    ] }),
    set: async (value) => writes.push(structuredClone(value)),
  });
  journal.record({ reason: 'verification_failed', at: 102, command: Command.HANDSHAKE, pin: '123456' });
  journal.record({ reason: 'connected', at: NaN });
  journal.record({ reason: 'private-secret', at: 103 });
  const clean = await journal.read();
  assert.equal(clean.length, 3);
  assert.equal(clean.at(-1).command, Command.HANDSHAKE);
  assert.doesNotMatch(JSON.stringify(writes), /private|example|123456|password"|url"/);
  for (let i = 0; i < 60; i++) journal.record({ reason: 'metadata_slow', at: i, command: 'private-command' });
  const bounded = await journal.read();
  assert.equal(bounded.length, 40);
  assert.equal(bounded[0].at, 20);
  bounded[0].reason = 'mutated';
  assert.equal((await journal.read())[0].reason, 'metadata_slow');
});

test('events arriving before storage loads append after history rather than erasing it', async () => {
  const loaded = deferred();
  const journal = createNativeDiagnosticJournal({ get: () => loaded.promise, set: async () => {} });
  journal.record({ reason: 'connected', at: 100 });
  loaded.resolve({ passwordNativeDiagnosticHistory: [{ reason: 'response_timeout', at: 50, command: 4 }] });
  assert.deepEqual((await journal.read()).map((event) => event.reason), ['response_timeout', 'worker_started', 'connected']);
});

test('storage failure cannot break native operations or future diagnostics', async () => {
  const journal = createNativeDiagnosticJournal({ get: async () => { throw Error('unavailable'); }, set: async () => { throw Error('unavailable'); } });
  const client = new ApplePasswords({ onDiagnosticEvent: journal.record });
  client._recordNativeEvent('connected');
  assert.deepEqual((await journal.read()).map((event) => event.reason), ['worker_started', 'connected']);
  client._recordNativeEvent('helper_exited');
  assert.equal((await journal.read()).at(-1).reason, 'helper_exited');
});
