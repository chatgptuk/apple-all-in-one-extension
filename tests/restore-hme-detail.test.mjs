import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, loadTs } from './source-harness.mjs';

const model = loadTs('src/pages/Popup/management-model.ts');
const matching = loadTs('src/hme-site-matching.ts');
const mail = loadTs('src/iCloudMailClient.ts', {
  './mailVerificationCode': { extractMailVerificationCode: () => { throw new Error('Restoration must not scan mail'); } },
});
const client = { setupUrl: 'https://setup.icloud.com/setup/ws/1', dsid: 'current-account', hasWebservice: () => true };
const keyOf = (value) => `${value.setupUrl}\n${value.dsid || ''}`;
const accountKey = keyOf(client);
const aliases = [
  { anonymousId: 'a', hme: 'a@icloud.com', label: 'Zebra', domain: 'example.test', createTimestamp: 3, isActive: true },
  { anonymousId: 'b', hme: 'b@icloud.com', label: 'Beta', domain: 'other.test', createTimestamp: 2, isActive: true },
  { anonymousId: 'c', hme: 'c@icloud.com', label: 'Alpha', domain: 'example.test', createTimestamp: 1, isActive: false },
];
const defaults = { isManager: false, getCurrentHost: async () => 'https://example.test/login' };

function harness({ list, snapshot, links, stored = {}, get, globals = {}, clientOverrides = {} } = {}) {
  const calls = [];
  const currentClient = { ...client, ...clientOverrides };
  class Service {
    constructor(value) { assert.equal(value, currentClient); }
    async listHme(force) { calls.push(['list', force]); return list ? list() : { hmeEmails: aliases }; }
    async snapshot() { calls.push(['snapshot']); return snapshot?.(); }
    async siteLinks() { calls.push(['links']); return links ? links() : {}; }
  }
  const { restoreHmeDetail } = loadTs('src/pages/Popup/restore-hme-detail.ts', {
    'webextension-polyfill': { default: { storage: { local: {
      get: async (keys) => { calls.push(['get', ...keys]); return get ? get(keys) : stored; },
    } } } },
    '../../hmeService': { ManagedPremiumMailSettings: Service },
    '../../hmeRepository': { hmeListCacheKey: keyOf },
    '../../hme-site-matching': matching,
    '../../iCloudMailClient': mail,
    './management-model': model,
  }, globals);
  return { restore: (id = 'b', options = {}) => restoreHmeDetail(currentClient, id, { ...defaults, ...options }), calls };
}
const ids = (items) => Array.from(items, (item) => item.anonymousId);

test('restores a saved detail from the account list without forcing refresh or scanning mail', async () => {
  const { restore, calls } = harness();
  const result = await restore();
  assert.equal(result.selected.anonymousId, 'b');
  assert.deepEqual(ids(result.addresses), ['a', 'b', 'c']);
  assert.deepEqual(calls, [['list', false], ['get', `hme-manager-view:${accountKey}`, `hme-mail-activity:${accountKey}`]]);
});

test('restores saved filtering/sort and cached mail timestamps from only the current account', async () => {
  const { restore } = harness({ stored: {
    [`hme-manager-view:${accountKey}`]: { filter: 'active', sort: 'activity' },
    [`hme-mail-activity:${accountKey}`]: { byAlias: { 'b@icloud.com': 200, 'a@icloud.com': 'invalid' } },
    'hme-mail-activity:other-account': { byAlias: { 'a@icloud.com': 999 } },
  } });
  const result = await restore();
  assert.deepEqual(ids(result.addresses), ['b', 'a']);
  assert.equal(result.selected.lastReceivedAt, 200);
  assert.equal(result.addresses[1].lastReceivedAt, undefined);
});

test('current-website neighbors include explicit site associations and inactive matching addresses', async () => {
  const { restore, calls } = harness({
    stored: { [`hme-manager-view:${accountKey}`]: { filter: 'current', sort: 'label' } },
    links: async () => ({ b: ['example.test'] }),
  });
  assert.deepEqual(ids((await restore()).addresses), ['c', 'b', 'a']);
  assert.equal(calls.filter(([operation]) => operation === 'links').length, 1);
});

test('preserves the saved address when current website or in-memory search excludes it', async () => {
  const current = harness({ stored: { [`hme-manager-view:${accountKey}`]: { filter: 'current' } } });
  assert.deepEqual(ids((await current.restore()).addresses), ['b']);
  const searched = harness();
  assert.deepEqual(ids((await searched.restore('b', { search: 'Zebra' })).addresses), ['b']);
});

test('standalone manager treats current-website filter as all without querying the active website', async () => {
  const { restore, calls } = harness({ stored: { [`hme-manager-view:${accountKey}`]: { filter: 'current', sort: 'label' } } });
  const result = await restore('b', { isManager: true, getCurrentHost: () => { throw new Error('Must not query tabs'); } });
  assert.deepEqual(ids(result.addresses), ['c', 'b', 'a']);
  assert.equal(calls.some(([operation]) => operation === 'links'), false);
});

test('missing IDs in a successful list return no detail and never revive a stale snapshot', async () => {
  const { restore, calls } = harness({ list: async () => ({ hmeEmails: [] }), snapshot: async () => ({ emails: aliases }) });
  const result = await restore();
  assert.equal(result.selected, undefined);
  assert.deepEqual(ids(result.addresses), []);
  assert.deepEqual(calls, [['list', false]]);
});

test('a transient list error can use the same-account snapshot but missing cached IDs remain retryable errors', async () => {
  const offline = new TypeError('Failed to fetch');
  const cached = harness({ list: async () => { throw offline; }, snapshot: async () => ({ emails: aliases }) });
  assert.equal((await cached.restore()).selected.anonymousId, 'b');
  const absent = harness({ list: async () => { throw offline; }, snapshot: async () => ({ emails: [] }) });
  await assert.rejects(absent.restore(), (error) => error === offline);
});

test('authentication and non-transient request errors never use cached account data', async () => {
  for (const status of [401, 403, 400, 404]) {
    const failure = Object.assign(new Error('Request failed'), { status });
    const { restore, calls } = harness({ list: async () => { throw failure; }, snapshot: async () => ({ emails: aliases }) });
    await assert.rejects(restore(), (error) => error === failure);
    assert.deepEqual(calls, [['list', false]]);
  }
});

test('authentication errors from site associations propagate instead of opening cached details', async () => {
  const failure = Object.assign(new Error('Expired'), { status: 401 });
  const { restore } = harness({
    stored: { [`hme-manager-view:${accountKey}`]: { filter: 'current' } },
    links: async () => { throw failure; },
  });
  await assert.rejects(restore(), (error) => error === failure);
});

test('presentation-storage failure falls back to the default list order', async () => {
  const { restore } = harness({ get: async () => { throw new Error('Storage unavailable'); } });
  assert.deepEqual(ids((await restore()).addresses), ['a', 'b', 'c']);
});

test('restored details retain unavailable activity for external forwarding inboxes without scanning mail', async () => {
  const { restore, calls } = harness({
    list: async () => ({ hmeEmails: aliases, selectedForwardTo: 'synthetic@example.test' }),
    stored: { [`hme-mail-activity:${accountKey}`]: { lastScanAt: 500, byAlias: {} } },
  });
  const result = await restore();
  assert.equal(result.selected.activityStatus, 'unavailable');
  assert.ok(result.addresses.every((item) => item.activityStatus === 'unavailable'));
  assert.deepEqual(calls.map(([operation]) => operation), ['list', 'get']);
});

test('iCloud forwarding restores ready only after a valid cached scan, otherwise idle', async () => {
  for (const [lastScanAt, expected] of [[500, 'ready'], [undefined, 'idle'], [0, 'idle'], ['500', 'idle'], [NaN, 'idle']]) {
    const { restore } = harness({
      list: async () => ({ hmeEmails: aliases, selectedForwardTo: 'synthetic@icloud.com' }),
      stored: { [`hme-mail-activity:${accountKey}`]: { lastScanAt, byAlias: {} } },
    });
    assert.equal((await restore()).selected.activityStatus, expected);
  }
});

test('forwarding fallback and mail service capability are preserved when restoring cached details', async () => {
  const withForwarding = aliases.map((item) => ({ ...item, forwardToEmail: 'synthetic@me.com' }));
  const itemFallback = harness({ list: async () => ({ hmeEmails: withForwarding }) });
  assert.equal((await itemFallback.restore()).selected.activityStatus, 'idle');
  const noService = harness({
    list: async () => ({ hmeEmails: withForwarding }),
    clientOverrides: { hasWebservice: () => false },
    stored: { [`hme-mail-activity:${accountKey}`]: { lastScanAt: 500 } },
  });
  assert.equal((await noService.restore()).selected.activityStatus, 'unavailable');
  const cached = harness({
    list: async () => { throw new TypeError('Offline'); },
    snapshot: async () => ({ emails: withForwarding, forwardTo: 'synthetic@example.test' }),
  });
  assert.equal((await cached.restore()).selected.activityStatus, 'unavailable');
});

test('a stalled service cannot leave restoration spinning beyond 12 seconds or continue reads after timing out', async () => {
  const request = deferred();
  let expire;
  let cleared = false;
  const { restore, calls } = harness({ list: () => request.promise, globals: {
    setTimeout: (callback, delay) => { assert.equal(delay, 12_000); expire = callback; return 1; },
    clearTimeout: (timer) => { assert.equal(timer, 1); cleared = true; },
  } });
  const pending = restore();
  expire();
  await assert.rejects(pending, /timed out/);
  assert.equal(cleared, true);
  request.resolve({ hmeEmails: aliases });
  await new Promise(setImmediate);
  assert.deepEqual(calls, [['list', false]]);
});
