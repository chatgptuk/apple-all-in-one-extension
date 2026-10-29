import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';
import { read, deferred, functionsFrom } from './source-harness.mjs';

// Run the component's real async/state handlers without requesting native secrets.
function mountPasswords(respond) {
  const source = read('src/pages/Popup/Popup.tsx');
  const start = source.indexOf('const PasswordsView =');
  const end = source.indexOf('  const detailOtpSeconds', start);
  assert.ok(start >= 0 && end > start);
  const slots = [], effects = [], listeners = new Set(), calls = [];
  let cursor = 0, ui, unmounted = false, lateWrites = 0;
  const context = vm.createContext({
    useState(value) {
      const index = cursor++;
      slots[index] ??= { value };
      return [slots[index].value, (next) => {
        if (unmounted) lateWrites++;
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useEffect(setup, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps.length === old.deps.length && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
      old?.cleanup?.();
      const effect = { setup, deps };
      slots[index] = effect;
      effects.push(effect);
    },
    sendPasswordMessage: async (message) => { calls.push(message.type); return respond(message); },
    getActiveTabForPopup: async () => ({ id: 1, url: 'https://example.test/login' }),
    browser: { runtime: { onMessage: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } } },
    tr: (en) => en, URL, console,
    fillFailureGuidance: (reason) => `guidance:${reason}`,
    window: { setTimeout, clearTimeout },
  });
  vm.runInContext(ts.transpileModule(`${source.slice(start, end)}
    return { state, hasChallenge, error, logins, otps, siteItemsLoading, otpItemsLoading,
      waitingForNative, loadSiteItems, verify, requestAccessCode, endNativeWait, fillAndShowLogin };
  }; globalThis.PasswordsView = PasswordsView;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const render = () => {
    cursor = 0;
    ui = context.PasswordsView();
    for (const effect of effects.splice(0)) effect.cleanup = effect.setup();
  };
  render();
  return {
    calls, get ui() { render(); return ui; },
    async flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); render(); },
    broadcast(state) { for (const listener of listeners) listener({ type: 'state', state }); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); unmounted = true; },
    lateWrites: () => lateWrites,
  };
}

test('busy metadata recovers when the prior request ends without another fill or authorization', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let pending = true, lookups = 0;
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return { state: 'unlocked', nativePending: pending };
    if (type === 'getLogins') return ++lookups === 1
      ? { ok: false, reason: 'native_busy' }
      : { ok: true, logins: [{ username: 'synthetic' }] };
    if (type === 'getOtpItems') return { ok: true, items: [] };
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  assert.equal(h.ui.waitingForNative, true);
  t.mock.timers.tick(1000);
  await h.flush();
  assert.equal(lookups, 1, 'poll only status while native work is pending');
  pending = false;
  t.mock.timers.tick(1000);
  await h.flush();
  assert.equal(h.ui.waitingForNative, false);
  assert.equal(h.ui.error, undefined);
  assert.equal(h.ui.logins[0].username, 'synthetic');
  assert.equal(lookups, 2);
  t.mock.timers.tick(10_000);
  await h.flush();
  assert.equal(lookups, 2, 'stop polling after recovery');
  assert.equal(h.calls.some((type) => ['connect', 'requestChallenge', 'fillOnPage', 'fillOtpOnPage'].includes(type)), false);
  h.unmount();
});

test('native timeout clears the stale busy screen and waits for explicit unlock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let state = 'unlocked';
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return { state, nativePending: state === 'unlocked' };
    if (type === 'getLogins') return { ok: false, reason: 'native_timeout' };
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  state = 'disconnected';
  t.mock.timers.tick(1000);
  await h.flush();
  assert.equal(h.ui.state, 'disconnected');
  assert.equal(h.ui.waitingForNative, false);
  assert.equal(h.ui.error, undefined);
  assert.equal(h.calls.includes('connect'), false);
  h.unmount();
});

test('manual end-wait resets before reconnecting and never replays the abandoned fill', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return { state: 'unlocked', nativePending: true };
    if (type === 'getLogins') return { ok: false, reason: 'native_busy' };
    if (type === 'resetConnection') return { ok: true, state: 'disconnected' };
    if (type === 'connect' || type === 'requestChallenge') return { ok: true, state: 'needs_pin', hasChallenge: true };
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  await h.ui.endNativeWait();
  await h.flush();
  assert.deepEqual(h.calls.slice(-3), ['resetConnection', 'connect', 'requestChallenge']);
  assert.equal(h.ui.state, 'needs_pin');
  assert.equal(h.ui.waitingForNative, false);
  assert.equal(h.ui.error, undefined);
  h.unmount();
});

test('closing the popup stops a pending busy-state poll before any recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const read = deferred();
  let reads = 0;
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return ++reads === 1 ? { state: 'unlocked' } : read.promise;
    if (type === 'getLogins') return { ok: false, reason: 'native_busy' };
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  t.mock.timers.tick(1000);
  h.unmount();
  read.resolve({ state: 'unlocked', nativePending: false });
  await h.flush();
  t.mock.timers.tick(10_000);
  assert.equal(reads, 2);
  assert.equal(h.lateWrites(), 0);
  assert.equal(h.calls.filter((type) => type === 'getLogins').length, 1);
});

test('closing during manual reset cannot launch a new authorization later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reset = deferred();
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return { state: 'unlocked', nativePending: true };
    if (type === 'getLogins') return { ok: false, reason: 'native_busy' };
    if (type === 'resetConnection') return reset.promise;
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  const ending = h.ui.endNativeWait();
  h.unmount();
  reset.resolve({ ok: true, state: 'disconnected' });
  await ending;
  assert.equal(h.calls.includes('connect'), false);
  assert.equal(h.lateWrites(), 0);
});

test('unlock broadcast and PIN response share one login/OTP lookup', async () => {
  const login = deferred();
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return { state: 'needs_pin', hasChallenge: true };
    if (type === 'verifyPin') {
      h.broadcast('unlocked');
      return { ok: true, state: 'unlocked' };
    }
    if (type === 'getLogins') return login.promise;
    if (type === 'getOtpItems') return { ok: true, items: [] };
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  const verifying = h.ui.verify('123456');
  await h.flush();
  assert.equal(h.calls.filter((type) => type === 'getLogins').length, 1);
  login.resolve({ ok: true, logins: [{ username: 'synthetic' }] });
  await verifying;
  await h.flush();
  assert.equal(h.calls.filter((type) => type === 'getOtpItems').length, 1);
  assert.equal(h.ui.logins[0].username, 'synthetic');
  assert.equal(h.ui.state, 'unlocked');
});

test('failed login lookup stops the chain and preserves its original error', async () => {
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return { state: 'unlocked' };
    if (type === 'getLogins') return { ok: false, error: 'native metadata timed out' };
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  assert.equal(h.calls.includes('getOtpItems'), false);
  assert.equal(h.ui.error, 'native metadata timed out');
  assert.equal(h.ui.siteItemsLoading, false);
  assert.equal(h.ui.otpItemsLoading, false);
});

test('session loss invalidates pending metadata instead of querying OTP or restoring old rows', async () => {
  const login = deferred();
  const h = mountPasswords(async ({ type }) => {
    if (type === 'getState') return { state: 'unlocked' };
    if (type === 'getLogins') return login.promise;
    throw new Error(`unexpected ${type}`);
  });
  await h.flush();
  h.broadcast('disconnected');
  login.resolve({ ok: true, logins: [{ username: 'stale' }] });
  await h.flush();
  assert.equal(h.ui.state, 'disconnected');
  assert.equal(h.ui.logins.length, 0);
  assert.equal(h.calls.includes('getOtpItems'), false);
  assert.equal(h.ui.siteItemsLoading, false);
});

test('closing a popup before its initial read resolves cannot launch a later unlock', async () => {
  const state = deferred();
  const h = mountPasswords(async () => state.promise);
  h.unmount();
  state.resolve({ state: 'disconnected' });
  await h.flush();
  assert.deepEqual(h.calls, ['getState']);
  assert.equal(h.lateWrites(), 0);
});

for (const type of ['request-unlock', 'new-code']) {
  test(`stale inline ${type} returns to logins if the toolbar already unlocked`, async () => {
    const messages = [];
    let reloads = 0;
    const win = {}; win.top = win;
    const { handleUiAction } = functionsFrom('src/passwords/content.js', ['handleUiAction'], {
      window: win,
      sendRuntimeMessage: async () => ({ ok: true, state: 'unlocked', hasChallenge: false }),
      reloadUiState: async () => reloads++,
      postUi: (message) => messages.push(message),
      L: (en) => en,
      validateUiAction: () => true,
    });
    await handleUiAction({ type });
    assert.equal(reloads, 1);
    assert.equal(messages.length, 0, 'no impossible PIN prompt without a challenge');
  });
}
