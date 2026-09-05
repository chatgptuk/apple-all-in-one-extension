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
