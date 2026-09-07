import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { read } from './source-harness.mjs';
import { createPasswordCache } from '../src/passwords/core/password-cache.js';
import { createPendingSaveQueue } from '../src/passwords/core/pending-saves.js';

const clock = () => {
  let at = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => at,
    setTimer: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: at + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      at += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= at) { timers.delete(id); timer.fn(); }
      }
    },
    timers,
  };
};
const credential = (username) => ({ username, password: 'synthetic-test-value' });
const save = (detected = 'synthetic-user') => ({ host: 'example.test', detected, password: 'synthetic-test-value', frameUrl: 'https://example.test/path?private=value', tabId: 7 });

test('password cache actively drops idle plaintext references without another read', () => {
  const time = clock();
  const cache = createPasswordCache({ idleTtlMs: 120_000, maxTtlMs: 300_000, ...time });
  cache.set('example.test', credential('one'));
  assert.equal(time.timers.size, 1);
  time.advance(120_000);
  assert.equal(cache.size, 0);
  assert.equal(time.timers.size, 0);
});

test('password cache enforces hard expiry, LRU capacity and one cancellable timer', () => {
  const time = clock();
  const cache = createPasswordCache({ idleTtlMs: 120_000, maxTtlMs: 300_000, maxEntries: 2, ...time });
  cache.set('example.test', credential('one'));
  cache.set('example.test', credential('two'));
  cache.get('example.test', 'one');
  cache.set('example.test', credential('three'));
  assert.equal(cache.get('example.test', 'two'), null);
  assert.equal(cache.size, 2);
  for (let i = 0; i < 2; i++) { time.advance(110_000); cache.get('example.test', 'one'); }
  time.advance(80_000);
  assert.equal(cache.size, 0);
  cache.set('example.test', credential('one'));
  cache.clear();
  assert.equal(time.timers.size, 0);
});

test('pending saves expire at five minutes without leaking passwords into metadata', () => {
  const time = clock();
  const discarded = [];
  const queue = createPendingSaveQueue({ ttlMs: 900_000, ...time, onDiscard: (meta, reason) => discarded.push({ meta, reason }) });
  const info = queue.enqueue(save());
  assert.equal(info.expiresAt, 300_000);
  assert.equal('password' in info, false);
  assert.equal('frameUrl' in queue.list()[0], false);
  time.advance(300_000);
  assert.equal(queue.size, 0);
  assert.equal(discarded[0].reason, 'expired');
  assert.equal(JSON.stringify(discarded).includes('synthetic-test-value'), false);
  assert.equal(JSON.stringify(discarded).includes('private=value'), false);
  assert.equal(time.timers.size, 0);
});

test('pending saves deduplicate exact accounts, cap retention and preserve retry expiry', () => {
  const time = clock();
  const discarded = [];
  const queue = createPendingSaveQueue({ maxEntries: 2, ...time, onDiscard: (_, reason) => discarded.push(reason) });
  queue.enqueue(save('User'));
  queue.enqueue(save('User'));
  queue.enqueue(save('user'));
  queue.enqueue(save('third'));
  assert.deepEqual(discarded, ['replaced', 'evicted']);
  const batch = queue.takeAll();
  assert.equal(batch.length, 2);
  assert.equal(queue.size, 0);
  time.advance(290_000);
  queue.requeue(batch[0]);
  assert.equal(queue.list()[0].expiresAt, 300_000);
  time.advance(10_000);
  assert.equal(queue.size, 0);
  assert.equal(queue.requeue(batch[1]), undefined);
});

test('failed saves cannot replace a newer submission and clear cancels timers', () => {
  const time = clock();
  const queue = createPendingSaveQueue({ ...time, onDiscard() { throw new Error('observer unavailable'); } });
  queue.enqueue(save());
  const [old] = queue.takeAll();
  time.advance(1);
  const next = queue.enqueue(save());
  assert.equal(queue.requeue(old), undefined);
  assert.equal(queue.list()[0].id, next.id);
  queue.clear();
  assert.equal(queue.size, 0);
  assert.equal(time.timers.size, 0);
});

test('taking one pending save leaves all remaining secrets under active expiry', () => {
  const time = clock();
  const queue = createPendingSaveQueue(time);
  queue.enqueue(save('first'));
  queue.enqueue(save('second'));
  const active = queue.takeNext();
  assert.equal(active.detected, 'first');
  assert.equal(queue.size, 1);
  assert.equal(time.timers.size, 1);
  time.advance(300_000);
  assert.equal(queue.size, 0);
  assert.equal(queue.takeNext(), undefined);
});

test('installation migration bounds injection fan-out and ignores normal worker events', async () => {
  let installed;
  let active = 0;
  let peak = 0;
  const injected = [];
  const eventRegistrations = [];
  const sandbox = {
    importScripts() {}, console,
    chrome: {
      runtime: { onInstalled: { addListener(fn) { installed = fn; } }, onStartup: { addListener() { eventRegistrations.push('startup'); } } },
      action: { enable: async () => {}, setPopup: async () => {} },
      tabs: {
        query: async () => [...Array.from({ length: 15 }, (_, id) => ({ id, url: 'https://example.test' })), { id: 90, url: 'chrome://extensions/' }, { id: 91, url: 'https://example.test', discarded: true }],
        onUpdated: { addListener() { eventRegistrations.push('update'); } },
        onActivated: { addListener() { eventRegistrations.push('activate'); } },
      },
      scripting: { executeScript: async ({ target }) => {
        active++; peak = Math.max(peak, active); injected.push(target.tabId);
        await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      } },
    },
  };
  vm.runInNewContext(read('src/background-bootstrap.js'), sandbox);
  assert.deepEqual(eventRegistrations, []);
  assert.equal(injected.length, 0);
  installed({ reason: 'browser_update' });
  assert.equal(injected.length, 0);
  installed({ reason: 'update' });
  installed({ reason: 'update' });
  await vm.runInNewContext('installationRepair', sandbox);
  assert.equal(injected.length, 30);
  assert.ok(peak <= 8, `Four tabs, at most two script requests per tab: ${peak}`);
  assert.ok(!injected.includes(90) && !injected.includes(91));
});
