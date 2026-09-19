import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { read, deferred } from './source-harness.mjs';

// Exercise the actual component's async handlers with a deterministic hook
// lifecycle. Browser QA separately covers React rendering and the packaged UI.
function mountGeneration(options = {}) {
  const source = read('src/pages/Popup/Popup.tsx');
  const component = source.slice(source.indexOf('const GenerateView ='), source.indexOf('const formatActivityTime'));
  const slots = [], effects = [], calls = { generate: [], reserve: [], copy: [], fill: [], created: 0 };
  let cursor = 0, tree, unmounted = false, lateWrites = 0;
  let props = { client: { account: 'a', revision: 1 }, onCreated: () => calls.created++ };
  const context = vm.createContext({
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: initial };
      return [slots[index].value, (next) => {
        if (unmounted) lateWrites++;
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(setup, deps) {
      const index = cursor++;
      const old = slots[index];
      if (old && deps.length === old.deps.length && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
      old?.cleanup?.();
      const effect = { setup, deps, cleanup: undefined };
      slots[index] = effect;
      effects.push(effect);
    },
    PremiumMailSettings: class {
      constructor(client) { this.client = client; }
      generateHme() {
        calls.generate.push(this.client);
        return options.generate?.(calls.generate.length) ?? Promise.resolve(`candidate-${calls.generate.length}@icloud.com`);
      }
      listHme() { return Promise.resolve({ selectedForwardTo: 'forward@example.test' }); }
      reserveHme(...args) {
        calls.reserve.push(args);
        return options.reserve?.(...args) ?? Promise.resolve({ anonymousId: 'created', hme: args[0] });
      }
    },
    navigator: { clipboard: { writeText(value) {
      calls.copy.push(value);
      return options.copy?.(value, calls.copy.length) ?? Promise.resolve();
    } } },
    sendMessageToTab: async (...args) => { calls.fill.push(args); },
    MessageType: { Autofill: 0 },
    getActiveTabForPopup: () => options.tab?.() ?? Promise.resolve({ url: 'https://example.test/login' }),
    IS_MANAGER: options.manager ?? false,
    tr: (en) => en, Symbol: 'Symbol', Spinner: 'Spinner', ErrorBanner: 'ErrorBanner', URL,
  });
  vm.runInContext(ts.transpileModule(`${component}\nglobalThis.GenerateView = GenerateView;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const render = () => {
    cursor = 0;
    tree = context.GenerateView(props);
    for (const effect of effects.splice(0)) effect.cleanup = effect.setup();
    return tree;
  };
  const nodes = (node) => !node || typeof node !== 'object' ? []
    : [node, ...node.props.children.flat(Infinity).flatMap((child) => nodes(child))];
  const text = (node) => node == null || typeof node === 'boolean' ? ''
    : typeof node !== 'object' ? String(node) : node.props.children.flat(Infinity).map((child) => text(child)).join('');
  const button = (name) => {
    const found = nodes(tree).find((node) => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name));
    assert.ok(found, `missing button ${name}`);
    return found.props;
  };
  render();
  return {
    calls, button, text: () => text(tree),
    async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); },
    refreshClient() { props = { ...props, client: { ...props.client, revision: props.client.revision + 1 } }; render(); },
    editLabel(value) { nodes(tree).find((node) => node.type === 'input').props.onChange({ target: { value } }); render(); },
    label: () => nodes(tree).find((node) => node.type === 'input').props.value,
    strictReplay() { for (const slot of slots.filter((slot) => slot?.setup)) { slot.cleanup?.(); slot.cleanup = slot.setup(); } },
    unmount() { for (const slot of slots) slot?.cleanup?.(); unmounted = true; },
    lateWrites: () => lateWrites,
  };
}

test('initial generation is stable across effect replay and same-account client refresh', async () => {
  const request = deferred();
  const ui = mountGeneration({ generate: () => request.promise });
  ui.strictReplay();
  ui.refreshClient();
  assert.equal(ui.calls.generate.length, 1);
  request.resolve('stable@icloud.com');
  await ui.flush();
  ui.editLabel('My draft');
  ui.refreshClient();
  await ui.flush();
  assert.equal(ui.calls.generate.length, 1);
  assert.match(ui.text(), /stable@icloud.com/);
  assert.equal(ui.label(), 'My draft');
  assert.equal(ui.calls.copy.length, 0, 'an unreserved candidate never changes the clipboard');
});

test('explicit regeneration uses the latest client and coalesces rapid duplicate clicks', async () => {
  const next = deferred();
  const ui = mountGeneration({ generate: (count) => count === 1 ? Promise.resolve('first@icloud.com') : next.promise });
  await ui.flush();
  ui.refreshClient();
  const refresh = ui.button('Generate another address').onClick;
  const first = refresh();
  const duplicate = refresh();
  await ui.flush();
  assert.equal(ui.calls.generate.length, 2);
  assert.equal(ui.calls.generate[1].revision, 2);
  assert.equal(ui.button('Create Address').disabled, true);
  assert.doesNotMatch(ui.text(), /first@icloud.com/);
  next.resolve('replacement@icloud.com');
  await Promise.all([first, duplicate]);
  await ui.flush();
  assert.match(ui.text(), /replacement@icloud.com/);
  assert.equal(ui.button('Create Address').disabled, false);
});

test('successful create copies the reserved response exactly once without implicit filling', async () => {
  const reservation = deferred();
  const ui = mountGeneration({ reserve: () => reservation.promise });
  await ui.flush();
  const creating = ui.button('Create Address').onClick();
  const duplicate = ui.button('Create and Fill').onClick();
  await ui.flush();
  assert.equal(ui.calls.reserve.length, 1);
  assert.equal(ui.calls.copy.length, 0);
  ui.refreshClient();
  reservation.resolve({ anonymousId: 'created', hme: 'confirmed@icloud.com' });
  await Promise.all([creating, duplicate]);
  await ui.flush();
  assert.deepEqual(ui.calls.copy, ['confirmed@icloud.com']);
  assert.equal(ui.calls.fill.length, 0);
  assert.equal(ui.calls.created, 1);
  assert.match(ui.text(), /Address Created and Copied/);
  ui.refreshClient();
  await ui.flush();
  assert.equal(ui.calls.generate.length, 1);
  assert.equal(ui.calls.copy.length, 1);
  assert.match(ui.text(), /confirmed@icloud.com/);
});

test('clipboard denial preserves successful creation and allows copying again without reserving again', async () => {
  const ui = mountGeneration({ copy: (_value, count) => count === 1 ? Promise.reject(new Error('denied')) : Promise.resolve() });
  await ui.flush();
  await ui.button('Create Address').onClick();
  await ui.flush();
  assert.match(ui.text(), /Address Created/);
  assert.match(ui.text(), /copying failed/);
  assert.doesNotMatch(ui.text(), /Address Created and Copied/);
  await ui.button('Copy').onClick();
  await ui.flush();
  assert.match(ui.text(), /Address Created and Copied/);
  assert.doesNotMatch(ui.text(), /copying failed/);
  assert.equal(ui.calls.reserve.length, 1);
  assert.equal(ui.calls.copy.length, 2);
});

test('explicit create-and-fill still fills if auto-copy is denied', async () => {
  const ui = mountGeneration({ copy: () => Promise.reject(new Error('denied')) });
  await ui.flush();
  await ui.button('Create and Fill').onClick();
  await ui.flush();
  assert.equal(ui.calls.copy.length, 1);
  assert.equal(ui.calls.fill.length, 1);
  assert.equal(ui.calls.fill[0][1], 'candidate-1@icloud.com');
  assert.match(ui.text(), /copying failed/);
});

test('failed reservation never copies and leaves an explicit retry available', async () => {
  const ui = mountGeneration({ reserve: () => Promise.reject(new Error('reserve failed')) });
  await ui.flush();
  await ui.button('Create Address').onClick();
  await ui.flush();
  assert.equal(ui.calls.copy.length, 0);
  assert.equal(ui.calls.created, 0);
  assert.match(ui.text(), /reserve failed/);
  assert.equal(ui.button('Create Address').disabled, false);
});

test('closing or replacing the account prevents late generation and reservation UI/clipboard effects', async () => {
  const generation = deferred();
  const generating = mountGeneration({ generate: () => generation.promise });
  generating.unmount();
  generation.resolve('stale@icloud.com');
  await generating.flush();
  assert.equal(generating.lateWrites(), 0);
  const reservation = deferred();
  const creating = mountGeneration({ reserve: () => reservation.promise });
  await creating.flush();
  const action = creating.button('Create and Fill').onClick();
  creating.unmount();
  reservation.resolve({ anonymousId: 'old-account', hme: 'old@icloud.com' });
  await action;
  assert.equal(creating.lateWrites(), 0);
  assert.equal(creating.calls.copy.length, 0);
  assert.equal(creating.calls.fill.length, 0);
  assert.equal(creating.calls.created, 0);
});

test('late current-tab lookup cannot replace an edited label', async () => {
  const tab = deferred();
  const ui = mountGeneration({ tab: () => tab.promise });
  ui.editLabel('Typed while loading');
  tab.resolve({ url: 'https://late.example.test/login' });
  await ui.flush();
  assert.equal(ui.label(), 'Typed while loading');
});

test('failed generation retries only on an explicit request', async () => {
  const ui = mountGeneration({ generate: (count) => count === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('retry@icloud.com') });
  await ui.flush();
  ui.refreshClient();
  await ui.flush();
  assert.equal(ui.calls.generate.length, 1);
  assert.equal(ui.button('Create Address').disabled, true);
  await ui.button('Generate another address').onClick();
  await ui.flush();
  assert.match(ui.text(), /retry@icloud.com/);
  assert.equal(ui.calls.generate.length, 2);
});

test('auto-copy requests only clipboard write permission, never clipboard read', () => {
  const manifest = JSON.parse(read('src/manifest.json'));
  assert.ok(manifest.permissions.includes('clipboardWrite'));
  assert.ok(!manifest.permissions.includes('clipboardRead'));
});
