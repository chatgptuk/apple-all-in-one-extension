import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { read, deferred, loadTs } from './source-harness.mjs';

const { addressDetailNavigation } = loadTs('src/pages/Popup/management-model.ts');
const { sanitizePopupNavigation } = loadTs('src/pages/Popup/popup-navigation.ts');

// Render the actual root component with deterministic hook lifecycles. Child
// views stay opaque here: browser QA verifies their real effects and rendering.
function mountPopup(options = {}) {
  const source = read('src/pages/Popup/Popup.tsx');
  const component = source.slice(source.indexOf('const Popup ='), source.indexOf('const SafePopup ='));
  const slots = [], effects = [], navigations = [], restorations = [];
  const stored = {
    popupState: 2,
    clientState: { setupUrl: 'https://setup.example.test', dsid: 'account-a' },
    autoHmeReconnect: false,
  };
  const setters = new Map();
  let ready = options.ready ?? true;
  let navigation = { version: 1, appSection: 'hide-email', hmeView: 'manage', ...options.navigation };
  let cursor = 0, tree, unmounted = false, lateWrites = 0;
  const nodes = (node) => !node || typeof node !== 'object' ? []
    : [node, ...node.props.children.flat(Infinity).flatMap(nodes)];
  const text = (node) => node == null || typeof node === 'boolean' ? ''
    : typeof node !== 'object' ? String(node) : node.props.children.flat(Infinity).map(text).join('');
  const memo = (compute, deps) => {
    const index = cursor++, old = slots[index];
    if (old && deps.length === old.deps.length && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return old.value;
    const value = compute();
    slots[index] = { value, deps };
    return value;
  };
  const navigate = (patch) => {
    navigations.push({ ...patch });
    navigation = { ...navigation, ...patch };
  };
  const context = vm.createContext({
    React: { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.setter = (next) => {
          if (unmounted) lateWrites++;
          slot.value = typeof next === 'function' ? next(slot.value) : next;
        };
        slots[index] = slot;
      }
      return [slots[index].value, slots[index].setter];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect(setup, deps) {
      const index = cursor++, old = slots[index];
      if (old && deps.length === old.deps.length && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
      old?.cleanup?.();
      const effect = { setup, deps };
      slots[index] = effect;
      effects.push(effect);
    },
    useBrowserStorageState(key) {
      if (!setters.has(key)) setters.set(key, (value) => { stored[key] = value; });
      return [stored[key], setters.get(key), false];
    },
    usePopupNavigation(routeContext) {
      // The real persistence hook has its own storage/race coverage. Sanitizing
      // here matches its synchronous account-boundary rendering guarantee.
      return { ready, navigation: sanitizePopupNavigation(navigation, routeContext), navigate };
    },
    restoreHmeDetail(client, id, config) {
      restorations.push({ client, id, config });
      return options.restore?.(client, id, restorations.length) ?? Promise.resolve({ selected: undefined, addresses: [] });
    },
    ICloudClient: class { async validateToken() {} },
    UnsuccessfulRequestError: class extends Error {},
    constructClient: (state) => ({ ...state }),
    hmeListCacheKey: (client) => client.dsid,
    getBrowserStorageValue: async (key) => stored[key],
    setBrowserStorageValue: async (key, value) => { stored[key] = value; },
    invalidateHmeListSnapshot: async () => {}, performDeauthSideEffects: async () => {},
    getActiveTabForPopup: async () => ({ url: 'https://current.example.test/login' }),
    normalizeHmeHost: (value) => new URL(value).hostname,
    addressDetailNavigation, managerQueries: new Map(),
    document: { documentElement: { classList: { toggle() {} } } },
    PopupState: { Authenticated: 0, SignedOut: 1, AuthenticatedAndManaging: 2 },
    DEFAULT_STORE: { autoHmeReconnect: false }, IS_MANAGER: options.manager ?? false,
    tr: (en) => en, cx: (...classes) => classes.filter(Boolean).join(' '), console,
    Header: 'Header', AppSegmentedControl: 'AppSegmentedControl', HmeSegmentedControl: 'HmeSegmentedControl',
    PasswordsView: 'PasswordsView', GenerateView: 'GenerateView', ManageView: 'ManageView',
    DetailsView: 'DetailsView', SignInView: 'SignInView', SiteTools: 'SiteTools',
    Spinner: 'Spinner', ErrorBanner: 'ErrorBanner',
  });
  vm.runInContext(ts.transpileModule(`${component}\nglobalThis.Popup = Popup;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const render = () => {
    cursor = 0;
    tree = context.Popup();
    for (const effect of effects.splice(0)) effect.cleanup = effect.setup();
    return tree;
  };
  const find = (type) => nodes(tree).find((node) => node.type === type)?.props;
  render();
  return {
    find, render, navigations, restorations, text: () => text(tree),
    button(name) { return nodes(tree).find((node) => node.type === 'button' && text(node) === name)?.props; },
    navigation: () => navigation,
    setReady(value) { ready = value; render(); },
    setAccount(dsid) { stored.clientState = { ...stored.clientState, dsid }; render(); },
    async flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); unmounted = true; },
    lateWrites: () => lateWrites,
  };
}

const alias = (id) => ({ anonymousId: id, hme: `${id}@icloud.com`, isActive: true });
const detailsRoute = { appSection: 'hide-email', hmeView: 'details', accountKey: 'account-a', anonymousId: 'second' };

test('route hydration renders no default password or address view before the destination is ready', async () => {
  const ui = mountPopup({ ready: false, navigation: detailsRoute });
  await ui.flush();
  for (const view of ['PasswordsView', 'GenerateView', 'ManageView', 'DetailsView']) assert.equal(ui.find(view), undefined);
  assert.equal(ui.restorations.length, 0);
  assert.ok(ui.find('Spinner'));
  ui.setReady(true);
  assert.equal(ui.restorations.length, 1);
  assert.equal(ui.find('PasswordsView'), undefined);
  assert.equal(ui.find('GenerateView'), undefined);
});

test('a saved address detail is resolved in the current account without rendering other functional views', async () => {
  const addresses = [alias('first'), alias('second'), alias('third')];
  const ui = mountPopup({ navigation: detailsRoute, restore: async () => ({ selected: addresses[1], addresses }) });
  await ui.flush();
  assert.equal(ui.find('DetailsView').hme.anonymousId, 'second');
  assert.equal(ui.restorations[0].client.dsid, 'account-a');
  assert.equal(ui.find('PasswordsView'), undefined);
  assert.equal(ui.find('GenerateView'), undefined);
  assert.equal(ui.find('ManageView'), undefined);
  ui.find('DetailsView').onNavigate('next');
  ui.render();
  assert.equal(ui.find('DetailsView').hme.anonymousId, 'third');
  assert.equal(ui.navigation().anonymousId, 'third');
  ui.find('DetailsView').onNavigate('previous');
  ui.render();
  assert.equal(ui.navigation().anonymousId, 'second');
  assert.equal(ui.restorations.length, 1, 'in-popup next/previous reuse the resolved list');
  ui.find('DetailsView').onBack();
  ui.render();
  assert.ok(ui.find('ManageView'));
  assert.equal(ui.navigation().anonymousId, undefined);
});

test('a deleted saved address falls back to My Addresses rather than a blank or creation page', async () => {
  const ui = mountPopup({ navigation: detailsRoute });
  await ui.flush();
  assert.ok(ui.find('ManageView'));
  assert.equal(ui.navigation().hmeView, 'manage');
  assert.equal(ui.navigation().accountKey, undefined);
  assert.equal(ui.navigation().anonymousId, undefined);
  assert.equal(ui.find('GenerateView'), undefined);
});

test('a delayed detail response cannot override an explicit navigation to another page', async () => {
  const response = deferred();
  const ui = mountPopup({ navigation: detailsRoute, restore: () => response.promise });
  ui.button('My Addresses').onClick();
  ui.render();
  response.resolve({ selected: alias('second'), addresses: [alias('second')] });
  await ui.flush();
  assert.ok(ui.find('ManageView'));
  assert.equal(ui.find('DetailsView'), undefined);
  assert.equal(ui.navigation().hmeView, 'manage');
});

test('account changes and popup closure discard an old detail restoration', async () => {
  const response = deferred();
  const ui = mountPopup({ navigation: detailsRoute, restore: () => response.promise });
  ui.setAccount('account-b');
  response.resolve({ selected: alias('second'), addresses: [alias('second')] });
  await ui.flush();
  assert.equal(ui.find('DetailsView'), undefined);
  assert.ok(ui.find('ManageView'));
  assert.equal(ui.find('ManageView').client.dsid, 'account-b');
  const late = deferred();
  const closing = mountPopup({ navigation: detailsRoute, restore: () => late.promise });
  closing.unmount();
  late.resolve({ selected: alias('second'), addresses: [alias('second')] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(closing.lateWrites(), 0);
});

test('restore errors offer retry and navigation without mounting the creation page', async () => {
  const ui = mountPopup({ navigation: detailsRoute, restore: async (_client, _id, attempt) => {
    if (attempt === 1) throw new Error('offline');
    return { selected: alias('second'), addresses: [alias('second')] };
  } });
  await ui.flush();
  assert.ok(ui.find('ErrorBanner'));
  assert.ok(ui.button('Retry'));
  assert.ok(ui.button('My Addresses'));
  assert.equal(ui.find('GenerateView'), undefined);
  ui.button('Retry').onClick();
  ui.render();
  await ui.flush();
  assert.equal(ui.find('DetailsView').hme.anonymousId, 'second');
});

test('switching to Passwords constructs a fresh current-site view without restored credential props', async () => {
  const pending = deferred();
  const ui = mountPopup({ navigation: detailsRoute, restore: () => pending.promise });
  ui.find('AppSegmentedControl').onChange('passwords');
  ui.render();
  assert.deepEqual(Object.keys(ui.find('PasswordsView')), ['children']);
  pending.resolve({ selected: alias('second'), addresses: [alias('second')] });
  await ui.flush();
  assert.equal(ui.find('DetailsView'), undefined);
  assert.equal(ui.navigation().appSection, 'passwords');
  assert.deepEqual(Object.keys(ui.find('PasswordsView')), ['children']);
});
