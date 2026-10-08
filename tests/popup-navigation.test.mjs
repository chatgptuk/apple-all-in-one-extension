import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, loadTs } from './source-harness.mjs';

const model = loadTs('src/pages/Popup/popup-navigation.ts');
const { defaultPopupNavigation, sanitizePopupNavigation, popupNavigationStorageKey } = model;
const plain = (value) => JSON.parse(JSON.stringify(value));
const account = 'https://setup.icloud.com/setup/ws/1\naccount-a';
const context = { isManager: false, accountKey: account, legacyManaging: false };
const details = { version: 1, appSection: 'hide-email', hmeView: 'details', accountKey: account, anonymousId: 'alias-a' };
const toolbarKey = popupNavigationStorageKey(false);
const managerKey = popupNavigationStorageKey(true);

function mountNavigation(options = {}) {
  const slots = [], effects = [], calls = { get: [], set: [] };
  const timers = new Map();
  let nextTimerId = 0;
  const stored = { ...options.stored };
  let props = { ...context, accountLoading: false, legacyLoading: false, ...options.props };
  let cursor = 0, result, unmounted = false, lateWrites = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (next) => {
        if (unmounted) lateWrites++;
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index].deps[i]))) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(setup, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps.length === old.deps.length && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
      old?.cleanup?.();
      const effect = { setup, deps };
      slots[index] = effect;
      effects.push(effect);
    },
  };
  const browser = { storage: { local: {
    get(key) {
      calls.get.push(key);
      return options.get?.(key, calls.get.length) ?? Promise.resolve({ [key]: stored[key] });
    },
    set(value) {
      calls.set.push(plain(value));
      if (options.set) return options.set(value);
      Object.assign(stored, plain(value));
      return Promise.resolve();
    },
  } } };
  const { usePopupNavigation } = loadTs('src/pages/Popup/usePopupNavigation.ts', {
    react: hooks,
    'webextension-polyfill': { default: browser },
    './popup-navigation': model,
  }, {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const render = () => {
    cursor = 0;
    result = usePopupNavigation(props);
    for (const effect of effects.splice(0)) effect.cleanup = effect.setup();
    return result;
  };
  render();
  return {
    calls, stored,
    timers,
    expireRead() {
      for (const [id, timer] of [...timers]) {
        assert.equal(timer.delay, 3000);
        timers.delete(id);
        timer.callback();
      }
    },
    value: () => result,
    render,
    update(patch) { props = { ...props, ...patch }; return render(); },
    async flush() {
      for (let round = 0; round < 4; round++) {
        for (let i = 0; i < 8; i++) await Promise.resolve();
        if (!unmounted) render();
      }
    },
    strictReplay() {
      const active = slots.filter((slot) => slot?.setup);
      for (const slot of active) slot.cleanup?.();
      for (const slot of active) slot.cleanup = slot.setup();
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); unmounted = true; },
    lateWrites: () => lateWrites,
  };
}

test('navigation defaults retain legacy managing and standalone-manager behavior', () => {
  assert.deepEqual(plain(defaultPopupNavigation(context)), { version: 1, appSection: 'passwords', hmeView: 'generate' });
  assert.equal(defaultPopupNavigation({ ...context, legacyManaging: true }).hmeView, 'manage');
  assert.deepEqual(plain(defaultPopupNavigation({ ...context, isManager: true })), { version: 1, appSection: 'hide-email', hmeView: 'manage' });
  assert.notEqual(toolbarKey, managerKey);
});

test('navigation sanitizer persists only identifiers and retains HME details behind password tab', () => {
  const result = sanitizePopupNavigation({
    ...details, appSection: 'passwords', password: 'secret', pin: '123456', otp: '654321',
    email: 'private@example.test', search: 'private', recentMail: ['private'], unlocked: true,
  }, context);
  assert.deepEqual(plain(result), { ...details, appSection: 'passwords' });
});

test('details require exact current account and a bounded nonempty identifier', () => {
  for (const patch of [
    { accountKey: undefined }, { accountKey: 'another-account' }, { anonymousId: undefined },
    { anonymousId: '' }, { anonymousId: '  ' }, { anonymousId: 'x'.repeat(256) },
    { anonymousId: 'id\nother' }, { anonymousId: 'id\u007f' },
  ]) {
    assert.deepEqual(plain(sanitizePopupNavigation({ ...details, ...patch }, context)),
      { version: 1, appSection: 'hide-email', hmeView: 'manage' });
  }
  assert.equal(sanitizePopupNavigation(details, { ...context, accountKey: '' }).hmeView, 'manage');
});

test('other HME pages drop detail IDs and unknown schemas fail to defaults', () => {
  assert.deepEqual(plain(sanitizePopupNavigation({ ...details, hmeView: 'generate' }, context)),
    { version: 1, appSection: 'hide-email', hmeView: 'generate' });
  for (const bad of [null, [], 'passwords', { version: 99 }, { hmeView: 'details' }]) {
    assert.deepEqual(plain(sanitizePopupNavigation(bad, context)), plain(defaultPopupNavigation(context)));
  }
  assert.equal(sanitizePopupNavigation({ ...details, appSection: 'passwords' }, { ...context, isManager: true }).appSection, 'hide-email');
});

test('hydration waits for account and legacy state and never writes default state prematurely', async () => {
  const pending = deferred();
  const ui = mountNavigation({ props: { accountLoading: true, legacyLoading: true }, get: () => pending.promise });
  assert.equal(ui.value().ready, false);
  assert.equal(ui.calls.get.length, 0);
  ui.update({ accountLoading: false });
  assert.equal(ui.calls.get.length, 0);
  ui.update({ legacyLoading: false });
  assert.equal(ui.calls.get.length, 1);
  ui.value().navigate({ appSection: 'hide-email' });
  assert.equal(ui.calls.set.length, 0);
  pending.resolve({ [toolbarKey]: details });
  await ui.flush();
  assert.equal(ui.value().ready, true);
  assert.deepEqual(plain(ui.value().navigation), details);
  assert.equal(ui.calls.set.length, 0);
});

test('missing navigation hydrates legacy page without persisting defaults', async () => {
  const ui = mountNavigation({ props: { legacyManaging: true } });
  await ui.flush();
  assert.equal(ui.value().ready, true);
  assert.deepEqual(plain(ui.value().navigation), { version: 1, appSection: 'passwords', hmeView: 'manage' });
  assert.equal(ui.calls.set.length, 0);
});

test('navigation writes immediately and rapid patches preserve the newest detail selection', async () => {
  const ui = mountNavigation();
  await ui.flush();
  const navigate = ui.value().navigate;
  navigate(details);
  navigate({ anonymousId: 'alias-b' });
  navigate({ appSection: 'passwords' });
  assert.equal(ui.calls.set.length, 3, 'writes are issued before rerender or teardown');
  assert.deepEqual(ui.stored[toolbarKey], { ...details, anonymousId: 'alias-b', appSection: 'passwords' });
  ui.unmount();
  navigate({ appSection: 'hide-email' });
  assert.equal(ui.calls.set.length, 3, 'stale handlers cannot write after unmount');
});

test('returning to the list clears detail identity without persisting sensitive extras', async () => {
  const ui = mountNavigation({ stored: { [toolbarKey]: details } });
  await ui.flush();
  ui.value().navigate({ hmeView: 'manage', password: 'secret', selectedIds: ['alias-a'] });
  assert.deepEqual(ui.stored[toolbarKey], { version: 1, appSection: 'hide-email', hmeView: 'manage' });
});

test('reopening restores the last action and navigate identity stays stable', async () => {
  const first = mountNavigation();
  await first.flush();
  const navigate = first.value().navigate;
  navigate(details);
  await first.flush();
  assert.equal(first.value().navigate, navigate);
  first.unmount();
  const reopened = mountNavigation({ stored: first.stored });
  await reopened.flush();
  assert.deepEqual(plain(reopened.value().navigation), details);
  const reopenedNavigate = reopened.value().navigate;
  reopened.update({ accountKey: 'new-account' });
  await reopened.flush();
  assert.equal(reopened.value().navigate, reopenedNavigate, 'account changes must not churn dependent client callbacks');
});

test('StrictMode cancels the first storage read and cannot overwrite a newer action', async () => {
  const first = deferred(), second = deferred();
  const ui = mountNavigation({ get: (_key, count) => count === 1 ? first.promise : second.promise });
  ui.strictReplay();
  second.resolve({ [toolbarKey]: details });
  await ui.flush();
  ui.value().navigate({ hmeView: 'manage' });
  first.resolve({ [toolbarKey]: { version: 1, appSection: 'passwords', hmeView: 'generate' } });
  await ui.flush();
  assert.equal(ui.value().navigation.appSection, 'hide-email');
  assert.equal(ui.value().navigation.hmeView, 'manage');
  assert.equal(ui.calls.set.length, 1);
});

test('account changes hide stale details immediately and persist their normalized fallback', async () => {
  const ui = mountNavigation({ stored: { [toolbarKey]: details } });
  await ui.flush();
  const immediate = ui.update({ accountKey: 'new-account' });
  assert.equal(immediate.ready, false);
  assert.equal(immediate.navigation.hmeView, 'manage');
  assert.equal(immediate.navigation.anonymousId, undefined);
  await ui.flush();
  assert.equal(ui.value().ready, true);
  assert.deepEqual(ui.stored[toolbarKey], { version: 1, appSection: 'hide-email', hmeView: 'manage' });
  assert.equal(ui.calls.get.length, 1, 'account transitions normalize in memory, not stale storage');
});

test('account switches cancel pending hydration before it can restore or save old details', async () => {
  const first = deferred(), second = deferred();
  const ui = mountNavigation({ get: (_key, count) => count === 1 ? first.promise : second.promise });
  ui.update({ accountKey: 'new-account' });
  first.resolve({ [toolbarKey]: details });
  await ui.flush();
  assert.equal(ui.value().ready, false);
  assert.equal(ui.calls.set.length, 0);
  second.resolve({ [toolbarKey]: details });
  await ui.flush();
  assert.equal(ui.value().ready, true);
  assert.equal(ui.value().navigation.hmeView, 'manage');
  assert.equal(ui.calls.set.length, 1);
});

test('manager and toolbar state are isolated and manager never restores passwords', async () => {
  const ui = mountNavigation({ stored: {
    [toolbarKey]: details,
    [managerKey]: { version: 1, appSection: 'passwords', hmeView: 'manage' },
  } });
  await ui.flush();
  ui.update({ isManager: true });
  assert.equal(ui.value().ready, false);
  await ui.flush();
  assert.equal(ui.value().navigation.appSection, 'hide-email');
  assert.equal(ui.value().navigation.hmeView, 'manage');
  ui.value().navigate({ hmeView: 'generate' });
  assert.deepEqual(ui.stored[toolbarKey], details);
  assert.equal(ui.stored[managerKey].hmeView, 'generate');
});

test('storage failures preserve usable in-memory navigation and unmount cancels hydration', async () => {
  const ui = mountNavigation({ get: () => Promise.reject(new Error('unavailable')), set: () => Promise.reject(new Error('denied')) });
  await ui.flush();
  assert.equal(ui.value().ready, true);
  ui.value().navigate({ appSection: 'hide-email', hmeView: 'manage' });
  await ui.flush();
  assert.equal(ui.value().navigation.hmeView, 'manage');
  const pending = deferred();
  const closed = mountNavigation({ get: () => pending.promise });
  closed.unmount();
  assert.equal(closed.timers.size, 0);
  pending.resolve({ [toolbarKey]: details });
  await closed.flush();
  assert.equal(closed.lateWrites(), 0);
  assert.equal(closed.calls.set.length, 0);
});

test('stalled navigation read falls back within three seconds without overwriting saved state', async () => {
  const request = deferred();
  const ui = mountNavigation({ props: { legacyManaging: true }, get: () => request.promise });
  await ui.flush();
  assert.equal(ui.value().ready, false);
  assert.equal(ui.timers.size, 1);
  ui.expireRead();
  await ui.flush();
  assert.equal(ui.value().ready, true);
  assert.deepEqual(plain(ui.value().navigation), { version: 1, appSection: 'passwords', hmeView: 'manage' });
  assert.equal(ui.calls.set.length, 0, 'a timeout must not replace a valid stored destination with defaults');
  assert.equal(ui.timers.size, 0);
});

test('a storage response arriving after timeout cannot undo subsequent user navigation', async () => {
  const request = deferred();
  const ui = mountNavigation({ get: () => request.promise });
  ui.expireRead();
  await ui.flush();
  ui.value().navigate({ appSection: 'hide-email', hmeView: 'manage' });
  request.resolve({ [toolbarKey]: details });
  await ui.flush();
  assert.deepEqual(plain(ui.value().navigation), { version: 1, appSection: 'hide-email', hmeView: 'manage' });
  assert.equal(ui.calls.set.length, 1);
  assert.equal(ui.timers.size, 0);
});

test('successful hydration and StrictMode cancellation clear their read deadlines', async () => {
  const request = deferred();
  const ui = mountNavigation({ get: () => request.promise });
  ui.strictReplay();
  assert.equal(ui.timers.size, 1, 'replayed effect removes the first deadline');
  request.resolve({ [toolbarKey]: details });
  await ui.flush();
  assert.equal(ui.value().ready, true);
  assert.equal(ui.timers.size, 0);
});
