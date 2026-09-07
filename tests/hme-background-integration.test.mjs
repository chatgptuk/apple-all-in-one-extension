import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from './source-harness.mjs';

const setupUrl = 'https://setup.icloud.com/setup/ws/1';
const services = {
  premiummailsettings: {
    url: 'https://maildomain.icloud.com',
    status: 'active',
  },
};
function harness(fetch) {
  const messages = [],
    notifications = [],
    listeners = [];
  const state = {
    clientState: { setupUrl, webservices: services, dsid: 'A' },
    popupState: 0,
    iCloudHmeOptions: { autofill: { button: true, contextMenu: true } },
  };
  const event = () => ({ addListener() {}, removeListener() {} });
  const storage = (data) => ({
    get: async (key) =>
      Object.fromEntries(
        (typeof key === 'string' ? [key] : key || Object.keys(data)).map(
          (name) => [name, data[name]]
        )
      ),
    set: async (values) => {
      Object.assign(data, values);
    },
    remove: async (key) => {
      delete data[key];
    },
  });
  const browser = {
    runtime: {
      id: 'test-extension',
      getURL: (p) => `chrome-extension://test-extension/${p}`,
      onInstalled: event(),
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (msg) => {
        messages.push(msg);
      },
    },
    storage: {
      local: storage(state),
      session: storage({}),
      onChanged: event(),
    },
    contextMenus: { update: async () => {}, onClicked: event() },
    notifications: {
      create: async (msg) => {
        notifications.push(msg);
      },
    },
    webRequest: { onResponseStarted: event() },
    tabs: { query: async () => [], sendMessage: async () => {} },
  };
  const cloud = loadTs('src/iCloudClient.ts', {}, { fetch });
  const repo = loadTs('src/hmeRepository.ts', { './iCloudClient': cloud });
  const matching = loadTs('src/hme-site-matching.ts');
  const links = loadTs('src/hme-site-links.ts', { './hme-site-matching': matching });
  loadTs(
    'src/pages/Background/index.ts',
    {
      '../../passwords/core/background.js': {},
      '../../storage': {
        getBrowserStorageValue: async (key) => state[key],
        setBrowserStorageValue: async (key, value) => {
          if (value === undefined) delete state[key];
          else state[key] = value;
        },
        DEFAULT_STORE: {
          popupState: 1,
          autoHmeReconnect: true,
          iCloudHmeOptions: state.iCloudHmeOptions,
        },
      },
      '../../iCloudClient': cloud,
      '../../hmeRepository': repo,
      '../../hme-site-matching': matching,
      '../../hme-site-links': links,
      '../../messages': {
        MessageType: { GenerateRequest: 1, ReservationRequest: 2 },
        sendMessageToTab: async () => {},
      },
      'webextension-polyfill': { default: browser },
      './constants': {
        CONTEXT_MENU_ITEM_ID: 'hme',
        loadingCopy: () => '',
        notificationTitleCopy: () => 'HME',
        notificationMessageCopy: () => '',
        signedInCtaCopy: () => '',
        signedOutCtaCopy: () => '',
      },
      '../../i18n': { initializeI18n: async () => {}, tr: (en) => en },
    },
    { chrome: { runtime: {}, scripting: {} } }
  );
  const sender = {
    id: 'test-extension',
    url: 'https://example.test/signup',
    tab: { id: 1 },
    frameId: 0,
  };
  return {
    state,
    messages,
    notifications,
    async send(message, origin = sender) {
      for (const fn of listeners) {
        const response = fn(message, origin);
        if (response !== undefined) return await response;
      }
    },
    manager(operation, args = [], url = 'popup.html') {
      return this.send(
        { type: 'hme:manager', key: setupUrl + '\nA', operation, args },
        { id: 'test-extension', url: browser.runtime.getURL(url) }
      );
    },
  };
}

test('real HME background preserves the session on offline/429 and clears it on 401', async () => {
  for (const mode of ['offline', 429, 401]) {
    const h = harness(async () => {
      if (mode === 'offline') throw new TypeError('Offline');
      return { ok: false, status: mode };
    });
    const reply = await h.send({ type: 'hme:create-for-site' });
    assert.equal(reply.ok, false);
    assert.equal(!!h.state.clientState, mode !== 401);
    assert.match(
      reply.error,
      mode === 401 ? /expired/ : mode === 429 ? /rate limiting/ : /connection/
    );
  }
});

test('expired inline list lookups cannot continue advertising a ready session', async () => {
  const h = harness(async () => ({ ok: false, status: 401 }));
  const reply = await h.send({ type: 'hme:inline-state', wantAlias: true });
  assert.equal(reply.ready, false);
  assert.equal(reply.ok, false);
  assert.equal(h.state.clientState, undefined);
});

test('manager mutations are restricted to popup/options and immediately update inline reuse', async () => {
  let reads = 0;
  const h = harness(async (url) => {
    if (url.endsWith('/list')) {
      reads++;
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: {
            hmeEmails: [
              {
                anonymousId: 'id-A',
                hme: 'synthetic@icloud.com',
                label: 'example.test',
                isActive: true,
                createTimestamp: 1,
              },
            ],
            selectedForwardTo: '',
            forwardToEmails: [],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ success: true, result: {} }) };
  });
  assert.equal((await h.manager('list')).ok, true);
  assert.equal(
    (await h.manager('delete', ['id-A'], 'src/inline.html')).error,
    'forbidden'
  );
  assert.equal(
    (await h.send({ type: 'hme:inline-state', wantAlias: true })).existingHme
      .hme,
    'synthetic@icloud.com'
  );
  assert.equal((await h.manager('deactivate', ['id-A'])).ok, true);
  assert.equal(
    (await h.send({ type: 'hme:inline-state', wantAlias: true })).existingHme,
    undefined
  );
  assert.equal(
    (
      await h.send({
        type: 'hme:create-for-site',
        existingHme: 'synthetic@icloud.com',
      })
    ).ok,
    false
  );
  assert.equal(reads, 1);
  assert.ok(h.messages.some((message) => message.type === 'hme:list-changed'));
  assert.equal((await h.manager('list', [], 'options.html')).ok, true);
});

test('exact aliases outrank newer parent aliases, multiple choices are validated against this frame', async () => {
  let requests = 0;
  const emails = [
    { anonymousId: 'parent', hme: 'parent@icloud.com', domain: 'example.test', isActive: true, createTimestamp: 100 },
    { anonymousId: 'exact', hme: 'exact@icloud.com', domain: 'login.example.test', isActive: true, createTimestamp: 1 },
    { anonymousId: 'disabled', hme: 'disabled@icloud.com', domain: 'login.example.test', isActive: false, createTimestamp: 200 },
    { anonymousId: 'unrelated', hme: 'other@icloud.com', domain: 'elsewhere.test', isActive: true, createTimestamp: 200 },
  ];
  const h = harness(async () => {
    requests++;
    return { ok: true, json: async () => ({ success: true, result: { hmeEmails: emails } }) };
  });
  const frame = { id: 'test-extension', url: 'https://login.example.test/signup', tab: { id: 9 }, frameId: 7 };
  const state = await h.send({ type: 'hme:inline-state', wantAlias: true }, frame);
  assert.deepEqual(Array.from(state.existingHmes, item => item.hme), ['exact@icloud.com', 'parent@icloud.com']);
  assert.equal(state.existingHme.match, 'exact');
  for (const address of ['exact@icloud.com', 'parent@icloud.com']) {
    assert.equal((await h.send({ type: 'hme:create-for-site', existingHme: address }, frame)).reused, true);
  }
  for (const address of ['disabled@icloud.com', 'other@icloud.com']) {
    assert.equal((await h.send({ type: 'hme:create-for-site', existingHme: address }, frame)).ok, false);
  }
  assert.equal(requests, 1, 'choosing an address never generates a new one');
});

test('website associations are local, account-isolated, usable and removed with deleted aliases', async () => {
  const h = harness(async url => ({ ok: true, json: async () => ({ success: true, result: url.endsWith('/list') ? {
    hmeEmails: [{ anonymousId: 'id-A', hme: 'linked@icloud.com', domain: 'other.test', isActive: true, createTimestamp: 1 }],
  } : {} }) }));
  assert.equal((await h.manager('site-links-set', ['id-A', ['EXAMPLE.test/signup']], 'popup.html?manager=1')).ok, true);
  assert.equal((await h.send({ type: 'hme:inline-state', wantAlias: true })).existingHme.match, 'linked');
  assert.equal((await h.send({ type: 'hme:create-for-site', existingHme: 'linked@icloud.com' })).reused, true);
  h.state.clientState.dsid = 'B';
  assert.equal((await h.send({ type: 'hme:inline-state', wantAlias: true })).existingHme, undefined);
  assert.equal((await h.manager('site-links')).ok, false, 'stale account manager key cannot read new account');
  h.state.clientState.dsid = 'A';
  assert.equal((await h.manager('site-links-set', ['not-owned', ['example.test']])).ok, false);
  assert.equal((await h.manager('delete', ['id-A'])).ok, true);
  assert.deepEqual(Object.keys((await h.manager('site-links')).result), []);
});

test('malformed manager operations, untrusted pages and retired numeric messages make no iCloud requests', async () => {
  let requests = 0;
  const h = harness(async () => { requests++; throw new Error('Must not reach iCloud'); });
  for (const [op, args] of [['unknown', []], ['list', ['yes']], ['delete', [{}]], ['metadata', ['id', '']], ['reserve', ['bad-address', 'label']], ['forward', ['x']], ['generate', [true]], ['list', {}], ['site-links-set', ['id', ['bad host']]], ['site-links-set', ['__proto__', ['example.test']]]]) {
    assert.equal((await h.manager(op, args)).ok, false, op);
  }
  for (const page of ['src/inline.html', 'popup.html.evil', 'other.html']) {
    assert.equal((await h.manager('generate', [], page)).error, 'forbidden');
  }
  for (const type of [1, 3]) assert.equal(await h.send({ type, data: { hme: 'synthetic@icloud.com' } }), undefined);
  assert.equal((await h.send({ type: 'hme:create-for-site' }, { id: 'test-extension', url: 'chrome-extension://test-extension/src/inline.html' })).error, 'forbidden');
  assert.equal(requests, 0);
});
