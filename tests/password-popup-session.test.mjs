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
  });
  vm.runInContext(ts.transpileModule(`${source.slice(start, end)}
    return { state, hasChallenge, error, logins, otps, siteItemsLoading, otpItemsLoading,
      loadSiteItems, verify, requestAccessCode };
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
