import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  read,
  loadTs,
  functionsFrom,
  contentMessageHandler,
  deferred,
} from './source-harness.mjs';
import {
  ApplePasswords,
  Command,
  State,
} from '../src/passwords/core/protocol.js';
import { selectAccountCode } from '../src/passwords/core/account-identity.js';
import { createPasswordCache } from '../src/passwords/core/password-cache.js';
import {
  passwordHints,
  positivePasswordLength,
} from '../src/passwords/password-rules.js';
import {
  passwordRole,
  formScope,
  generatedPasswordTargets,
} from '../src/passwords/form-context.js';

const setupUrl = 'https://setup.icloud.com/setup/ws/1';
const services = {
  premiummailsettings: {
    url: 'https://maildomain.icloud.com',
    status: 'active',
  },
};
const generator = () => {
  const context = { crypto: webcrypto, Uint32Array };
  vm.runInNewContext(read('src/passwords/password-generator.js'), context);
  return context.AppleAllInOnePasswordGenerator.generateCompatiblePassword;
};

test('generator constructs open-ended and concatenated pattern lengths correctly', () => {
  const generate = generator();
  for (let i = 0; i < 30; i++) {
    const open = generate({ pattern: '[A-Za-z0-9]{8,}' });
    assert.equal(open.compatible, true);
    assert.equal(open.password.length, 20);
    const prefix = generate({ pattern: '[A-Z][a-z0-9]{11}' });
    assert.equal(prefix.compatible, true);
    assert.match(prefix.password, /^[A-Z][a-z0-9]{11}$/);
    const symbols = generate({
      pattern: '(?=(?:.*[!@#]){2})[A-Za-z0-9!@#]{16}',
      requireSymbol: true,
      allowedSymbols: '!@#',
    });
    assert.equal(symbols.compatible, true);
    assert.match(symbols.password, /^(?=(?:.*[!@#]){2})[A-Za-z0-9!@#]{16}$/);
  }
});

test('generator respects literal symbol allowlists, impossible lengths and manual restrictions', () => {
  const generate = generator();
  const dot = generate({ allowedSymbols: '.', requireSymbol: true });
  assert.equal(dot.compatible, true);
  assert.match(dot.password, /\./);
  assert.match(dot.password, /^[A-Za-z0-9.]+$/);
  assert.equal(generate({ minLength: 200 }).compatible, false);
  assert.equal(generate({ maxLength: 7 }).compatible, false);
  assert.equal(
    generate(
      { allowedSymbols: '.', requireSymbol: true },
      { allowedSymbols: '@' }
    ).compatible,
    false
  );
  assert.equal(generate({ pattern: '(a+)+b' }).reason, 'unsupported_pattern');
  assert.equal(
    generate({ pattern: '[A-Z]{8,}' }, { length: 16 }).password.length,
    16
  );
  assert.equal(generate({ maxLength: 12 }, { length: 20 }).compatible, false);
  assert.doesNotMatch(generate().password, /-/);
});

test('field hint extraction recognizes ranges without inventing optional requirements', () => {
  const result = passwordHints(
    'Password: 8–16 characters. Uppercase letters are not required. Symbols are optional.'
  );
  assert.equal(result.minLength, 8);
  assert.equal(result.maxLength, 16);
  assert.equal(result.requireUpper, false);
  assert.equal(result.requireSymbol, false);
  assert.equal(generator()(result).password.length, 16);
  assert.equal(
    passwordHints('密码长度为12到24位，必须包含大写字母和数字。').requireUpper,
    true
  );
  assert.equal(passwordHints('Allowed symbols: .').allowedSymbols, '.');
  assert.equal(positivePasswordLength('200'), 200);
});

class Input {
  constructor(id, autocomplete = '', form = null) {
    Object.assign(this, {
      id,
      autocomplete,
      form,
      type: 'password',
      value: '',
      isConnected: true,
      disabled: false,
      readOnly: false,
      name: '',
      placeholder: '',
    });
  }
  getAttribute(name) {
    return this[name] ?? '';
  }
  closest() {
    return null;
  }
  getRootNode() {
    return this.parentElement;
  }
  focus() {}
}
const fillable = (field) =>
  field?.isConnected && !field.disabled && !field.readOnly;
const group = () => ({
  fields: [],
  querySelectorAll() {
    return this.fields;
  },
});

test('generated passwords fill only new/confirmation fields, never old, disabled or unrelated inputs', () => {
  const form = group();
  const old = new Input('current', 'current-password', form);
  const next = new Input('new', 'new-password', form);
  const confirm = new Input('confirm', 'new-password', form);
  const readonly = new Input('confirm-readonly', 'new-password', form);
  readonly.readOnly = true;
  const other = new Input('other', 'new-password', group());
  form.fields = [old, next, confirm, readonly, other];
  const context = functionsFrom(
    'src/passwords/content.js',
    ['fillGeneratedPassword'],
    {
      HTMLInputElement: Input,
      generatedPasswordTargets,
      isFillable: fillable,
      passwordMatchesField: () => true,
      setValue: (field, value) => {
        field.value = value;
      },
      everPassword: new WeakSet(),
      location: { hostname: 'example.test' },
    }
  );
  assert.equal(
    context.fillGeneratedPassword(next, 'SyntheticPassword1!'),
    true
  );
  assert.equal(old.value, '');
  assert.equal(other.value, '');
  assert.equal(readonly.value, '');
  assert.equal(next.value, confirm.value);
  assert.equal(context.fillGeneratedPassword(old, 'AnotherPassword1!'), false);
  confirm.value = '';
  confirm.maxLength = 8;
  context.passwordMatchesField = (password, field) =>
    !field.maxLength || password.length <= field.maxLength;
  assert.equal(
    context.fillGeneratedPassword(next, 'TooLongForConfirmation1!'),
    false
  );
  assert.equal(next.value, 'SyntheticPassword1!');
});

test('formless SPA and shadow-root groups do not cross into another password group', () => {
  const first = group(),
    second = group();
  const field = new Input('new', 'new-password');
  field.parentElement = first;
  const confirm = new Input('confirm');
  confirm.parentElement = first;
  const elsewhere = new Input('elsewhere', 'new-password');
  elsewhere.parentElement = second;
  first.fields = [field, confirm];
  second.fields = [elsewhere];
  assert.equal(formScope(field), first);
  assert.deepEqual(generatedPasswordTargets(field, fillable), [field, confirm]);
  assert.equal(passwordRole(new Input('old_password')), 'current');
  const labelled = new Input('opaque-input-id');
  labelled.labels = [{ textContent: 'Current password' }];
  assert.equal(passwordRole(labelled), 'current');
});

test('OTP and password cache preserve exact account identity', () => {
  const items = [
    { username: 'Admin', code: '111111' },
    { username: 'admin', code: '222222' },
  ];
  assert.equal(selectAccountCode(items, 'Admin').code, '111111');
  assert.equal(selectAccountCode(items, 'missing'), undefined);
  assert.equal(selectAccountCode(items, undefined), undefined);
  assert.equal(selectAccountCode(items, ' Admin'), undefined);
  const cache = createPasswordCache({ idleTtlMs: 1000, maxTtlMs: 2000 });
  cache.set('example.test', { username: 'Admin', password: 'synthetic' });
  assert.equal(cache.get('example.test', 'admin'), null);
  assert.equal(cache.get('example.test', 'Admin').password, 'synthetic');
});

test('native timeout retires its port; late replies cannot satisfy a new request', async () => {
  const client = new ApplePasswords();
  let disconnected = false;
  const oldPort = {
    postMessage() {},
    disconnect() {
      disconnected = true;
    },
  };
  client.port = oldPort;
  client.session = { sharedKey: 'synthetic' };
  client.state = State.Unlocked;
  await assert.rejects(
    client._send(Command.GET_LOGIN_NAMES_FOR_URL, {}, 5),
    /timeout/
  );
  assert.equal(disconnected, true);
  assert.equal(client.port, undefined);
  assert.equal(client.session, undefined);
  const newPort = { postMessage() {}, disconnect() {} };
  client.port = newPort;
  let resolved = false;
  const pending = client
    ._send(Command.GET_LOGIN_NAMES_FOR_URL, {}, 1000)
    .then((result) => {
      resolved = true;
      return result;
    });
  client._dispatch(
    { cmd: Command.GET_LOGIN_NAMES_FOR_URL, payload: 'stale' },
    oldPort
  );
  await Promise.resolve();
  assert.equal(resolved, false);
  client._dispatch(
    { cmd: Command.GET_LOGIN_NAMES_FOR_URL, payload: 'fresh' },
    newPort
  );
  assert.equal((await pending).payload, 'fresh');
  client.disconnect();
});

test('native disconnect rejects all waiters immediately and password responses are account-bound', async () => {
  const client = new ApplePasswords();
  client.port = { postMessage() {}, disconnect() {} };
  const pending = client._send(Command.GET_PASSWORD_FOR_LOGIN_NAME, {}, 60_000);
  client.disconnect();
  await assert.rejects(pending, /connection closed/);
  assert.equal(client._waiters.size, 0);
  client.port = {};
  client.session = { sharedKey: 'synthetic' };
  client.state = State.Unlocked;
  client._encryptedQuery = async () => ({
    STATUS: 0,
    Entries: [{ USR: 'admin', PWD: 'wrong-account' }],
  });
  assert.equal(
    await client.getPasswordForLoginName(1, 'https://example.test', {
      username: 'Admin',
    }),
    undefined
  );
});

test('native save without an acknowledgment does not time out or lock the session', async () => {
  const client = new ApplePasswords(),
    sent = [];
  client.port = {
    postMessage: (message) => sent.push(message),
    disconnect() {},
  };
  client.session = {
    sharedKey: 'synthetic',
    username: 'session',
    encrypt: async () => new Uint8Array(),
    serialize: () => '',
  };
  client.state = State.Unlocked;
  client._send = () => {
    throw new Error('Save must not wait for an optional acknowledgment');
  };
  assert.equal(
    await client.saveLogin(
      1,
      'https://example.test',
      'Admin',
      'SyntheticPassword1!'
    ),
    true
  );
  assert.equal(sent[0].cmd, Command.SET_PASSWORD_FOR_LOGIN_NAME_URL);
  assert.equal(client.ready, true);
  assert.equal(client._waiters.size, 0);
  client.disconnect();
});

test('secret delivery rejects a replaced document, navigation, removed input and closed chooser', () => {
  const anchor = new Input('username');
  anchor.type = 'text';
  let fills = 0;
  const context = contentMessageHandler({
    chrome: { runtime: { id: 'test' } },
    HTMLInputElement: Input,
    documentToken: 'document-A',
    pendingFill: null,
    location: {
      href: 'https://example.test/login',
      origin: 'https://example.test',
      hostname: 'example.test',
    },
    deepActiveElement: () => anchor,
    uiAnchor: null,
    fillAnchor: null,
    isFillable: fillable,
    firstVisibleOtpField: () => null,
    isUsernameField: () => true,
    isPasswordField: () => false,
    fillCredentials: () => {
      fills++;
      return true;
    },
    lastAutofill: null,
  });
  const message = (value) => {
    let result;
    context.listener(value, { id: 'test' }, (r) => {
      result = r;
    });
    return result;
  };
  const prepare = () =>
    message({ type: 'prepareFill', expectedOrigin: 'https://example.test' });
  const send = (lease) =>
    message({
      type: 'fill',
      username: 'Admin',
      password: 'synthetic',
      expectedOrigin: 'https://example.test',
      expectedDocumentToken: lease.documentToken,
      targetToken: lease.targetToken,
    });
  let lease = prepare();
  context.location.href = 'https://example.test/other';
  assert.equal(send(lease).filled, false);
  lease = prepare();
  anchor.isConnected = false;
  assert.equal(send(lease).filled, false);
  anchor.isConnected = true;
  lease = prepare();
  context.documentToken = 'document-B';
  assert.equal(send(lease).filled, false);
  lease = prepare();
  context.pendingFill = null;
  assert.equal(send(lease).filled, false);
  lease = prepare();
  anchor.value = 'user-edited';
  assert.equal(send(lease).filled, false);
  lease = prepare();
  context.location.origin = 'http://example.test';
  assert.equal(send(lease).filled, false);
  context.location.origin = 'https://example.test';
  lease = prepare();
  assert.equal(send(lease).filled, true);
  assert.equal(send(lease).filled, false);
  assert.equal(fills, 1);
});

test('closing a signup chooser during address creation leaves the form untouched and exposes recovery', async () => {
  const request = deferred(),
    anchor = new Input('email');
  anchor.type = 'email';
  const port = {},
    messages = [];
  const context = functionsFrom(
    'src/passwords/content.js',
    ['handleUiAction'],
    {
      uiAnchor: anchor,
      uiPort: port,
      signupInFlight: false,
      location: {
        href: 'https://example.test/signup',
        hostname: 'example.test',
      },
      validateUiAction: () => true,
      isHideEmailField: () => true,
      signupPasswordTarget: () => null,
      isFillable: fillable,
      sendRuntimeMessage: (message) => {
        messages.push(message.type);
        return message.type === 'hme:create-for-site'
          ? request.promise
          : Promise.resolve({ ok: true });
      },
      postUi: () => {},
      L: (en) => en,
      setValue: () => {
        throw new Error('Must not fill a stale target');
      },
    }
  );
  const action = context.handleUiAction({
    type: 'smart-signup',
    password: 'SyntheticPassword1!',
  });
  context.uiAnchor = null;
  context.uiPort = null;
  request.resolve({ ok: true, hme: 'synthetic@icloud.com' });
  await action;
  assert.equal(context.signupInFlight, false);
  assert.equal(anchor.value, '');
  assert.deepEqual(messages, ['hme:create-for-site', 'hme:created-unfilled']);
});

test('failed signup restores its operation state so retry works', async () => {
  const anchor = new Input('email'),
    messages = [];
  const context = functionsFrom(
    'src/passwords/content.js',
    ['handleUiAction'],
    {
      uiAnchor: anchor,
      uiPort: {},
      signupInFlight: false,
      location: { href: 'https://example.test/signup' },
      validateUiAction: () => true,
      isHideEmailField: () => true,
      signupPasswordTarget: () => null,
      sendRuntimeMessage: async () => ({ ok: false, error: 'Offline' }),
      postUi: (message) => messages.push(message.type),
      L: (en) => en,
    }
  );
  await context.handleUiAction({
    type: 'smart-signup',
    password: 'SyntheticPassword1!',
  });
  assert.equal(context.signupInFlight, false);
  assert.deepEqual(messages, ['error', 'operation-finished']);
  const button = { disabled: true, querySelector: () => ({ textContent: '' }) };
  const ui = functionsFrom(
    'src/passwords/inline.js',
    ['finishSignupOperation'],
    { content: { querySelector: () => button }, L: (en) => en }
  );
  ui.finishSignupOperation();
  assert.equal(button.disabled, false);
});

const makeRepository = (fetch, now = Date.now, persisted = new Map()) => {
  const cloud = loadTs('src/iCloudClient.ts', {}, { fetch });
  const { HmeRepository, hmeListCacheKey } = loadTs('src/hmeRepository.ts', {
    './iCloudClient': cloud,
  });
  const events = [];
  const repository = new HmeRepository(
    {
      read: async (key) => persisted.get(key),
      write: async (key, value) => {
        if (value) persisted.set(key, structuredClone(value));
        else persisted.delete(key);
      },
      changed: (key) => events.push(key),
    },
    now
  );
  const client = new cloud.default(setupUrl, services, 'account-A');
  return {
    repository,
    client,
    events,
    persisted,
    key: hmeListCacheKey(client),
    cloud,
  };
};
const alias = {
  anonymousId: 'id-A',
  hme: 'synthetic@icloud.com',
  isActive: true,
  label: 'example.test',
  note: '',
  createTimestamp: 1,
};
const okList = () => ({
  ok: true,
  json: async () => ({
    success: true,
    result: {
      hmeEmails: [{ ...alias }],
      selectedForwardTo: 'redacted',
      forwardToEmails: [],
    },
  }),
});

test('repository shares list reads across callers and worker reopens; UI counters do not cause refetch', async () => {
  let calls = 0,
    clock = 100;
  const fetch = async () => {
    calls++;
    return okList();
  };
  const first = makeRepository(fetch, () => clock);
  const results = await Promise.all([
    first.repository.execute(first.client, 'list'),
    first.repository.execute(first.client, 'list'),
  ]);
  assert.equal(calls, 1);
  assert.equal(results[0].hmeEmails[0].anonymousId, 'id-A');
  const reopened = makeRepository(fetch, () => clock, first.persisted);
  await reopened.repository.execute(reopened.client, 'list');
  assert.equal(calls, 1);
  clock += 120_001;
  await reopened.repository.execute(reopened.client, 'list');
  assert.equal(calls, 2);
});

test('metadata, activation, deletion and creation patch the one shared list without extra GETs', async () => {
  let reads = 0;
  const state = makeRepository(async (url) => {
    if (url.endsWith('/list')) {
      reads++;
      return okList();
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: url.endsWith('/reserve')
          ? { hme: { ...alias, anonymousId: 'id-B' } }
          : {},
      }),
    };
  });
  const run = (operation, args) =>
    state.repository.execute(state.client, operation, args);
  await run('list');
  await run('metadata', ['id-A', 'Renamed', 'New note']);
  assert.equal((await run('list')).hmeEmails[0].label, 'Renamed');
  await run('deactivate', ['id-A']);
  assert.equal((await run('list')).hmeEmails[0].isActive, false);
  await run('reactivate', ['id-A']);
  assert.equal((await run('list')).hmeEmails[0].isActive, true);
  await run('delete', ['id-A']);
  assert.equal((await run('list')).hmeEmails.length, 0);
  await run('reserve', ['new@icloud.com', 'New']);
  assert.equal((await run('list')).hmeEmails[0].anonymousId, 'id-B');
  assert.equal(reads, 1);
  assert.ok(state.events.length >= 6);
});

test('an in-flight list cannot resurrect an address after a queued delete or account invalidation', async () => {
  const gate = deferred();
  const state = makeRepository(async (url) =>
    url.endsWith('/list')
      ? gate.promise
      : { ok: true, json: async () => ({ success: true, result: {} }) }
  );
  const listing = state.repository.execute(state.client, 'list');
  const removal = state.repository.execute(state.client, 'delete', ['id-A']);
  gate.resolve(okList());
  await listing;
  await removal;
  assert.equal(
    (await state.repository.execute(state.client, 'list')).hmeEmails.length,
    0
  );
  const second = deferred();
  const expired = makeRepository(async () => second.promise);
  const stale = expired.repository.execute(expired.client, 'list');
  await new Promise((resolve) => setImmediate(resolve));
  await expired.repository.invalidate(expired.key);
  second.resolve(okList());
  await assert.rejects(stale, /session changed/);
  assert.equal(expired.persisted.has(expired.key), false);
});

test('offline/429 preserve authentication; only authentication failures return signed out', async () => {
  for (const mode of ['offline', 429, 401, 403, 503]) {
    const cloud = loadTs(
      'src/iCloudClient.ts',
      {},
      {
        fetch: async () => {
          if (mode === 'offline') throw new TypeError('network unavailable');
          return { ok: false, status: mode, headers: { get: () => '2' } };
        },
      }
    );
    const client = new cloud.default(setupUrl, services, 'A');
    if (mode === 401 || mode === 403)
      assert.equal(await client.isAuthenticated(), false);
    else
      await assert.rejects(
        client.isAuthenticated(),
        (error) =>
          cloud.classifyICloudFailure(error) ===
          (mode === 429
            ? 'rate_limited'
            : mode === 'offline'
              ? 'offline'
              : 'unavailable')
      );
  }
});

test('429 honors Retry-After and preserves cached addresses without automatic mutation retries', async () => {
  let calls = 0,
    clock = 1000;
  const state = makeRepository(
    async () => {
      calls++;
      return calls === 1
        ? okList()
        : { ok: false, status: 429, headers: { get: () => '2' } };
    },
    () => clock
  );
  await state.repository.execute(state.client, 'list');
  await assert.rejects(
    state.repository.execute(state.client, 'delete', ['id-A']),
    (e) => e.status === 429
  );
  await assert.rejects(
    state.repository.execute(state.client, 'delete', ['id-A']),
    (e) => e.status === 429
  );
  assert.equal(calls, 2);
  assert.equal(
    (await state.repository.execute(state.client, 'snapshot')).emails.length,
    1
  );
  clock += 2001;
  await assert.rejects(
    state.repository.execute(state.client, 'delete', ['id-A'])
  );
  assert.equal(calls, 3);
});
