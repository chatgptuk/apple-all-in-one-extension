(() => {
  const params = new URLSearchParams(location.search);
  const appearance = params.get('appearance');
  if (appearance === 'dark' || appearance === 'light')
    document.documentElement.style.setProperty('color-scheme', appearance, 'important');
  // Reproduce an HTTP page's Web Crypto surface without touching real accounts.
  if (params.get('httpCrypto') === '1')
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  const event = () => ({
    listeners: [],
    addListener(fn) {
      this.listeners.push(fn);
    },
    removeListener(fn) {
      this.listeners = this.listeners.filter((item) => item !== fn);
    },
    emit(...args) {
      this.listeners.forEach((fn) => fn(...args));
    },
  });
  const runtimeMessages = event(),
    storageChanges = event();
  const services = {
    premiummailsettings: {
      url: 'https://qa-mail.icloud.com',
      status: 'active',
    },
  };
  const local = {
    languagePreference: params.get('lang') === 'zh-CN' ? 'zh-CN' : 'en',
    popupState: 2,
    clientState: {
      setupUrl: 'https://setup.icloud.com/setup/ws/1',
      webservices: services,
      dsid: 'synthetic-account',
    },
    iCloudHmeOptions: { autofill: { button: true, contextMenu: true } },
    autoHmeReconnect: true,
  };
  const session = {};
  const respond = (value, cb) => {
    if (cb) queueMicrotask(() => cb(value));
    return Promise.resolve(value);
  };
  const storage = (record, area) => ({
    get(keys, cb) {
      const result = {};
      for (const key of typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys)
          ? keys
          : Object.keys(keys || record))
        result[key] = record[key] ?? keys?.[key];
      return respond(result, cb);
    },
    set(values, cb) {
      const changes = {};
      for (const key in values) {
        changes[key] = { oldValue: record[key], newValue: values[key] };
        record[key] = values[key];
      }
      queueMicrotask(() => storageChanges.emit(changes, area));
      return respond(undefined, cb);
    },
    remove(keys, cb) {
      const changes = {};
      for (const key of [].concat(keys)) {
        changes[key] = { oldValue: record[key] };
        delete record[key];
      }
      queueMicrotask(() => storageChanges.emit(changes, area));
      return respond(undefined, cb);
    },
  });
  let emails = [
    {
      anonymousId: 'qa-alias',
      hme: 'synthetic@icloud.com',
      domain: 'example.test',
      label: 'Example Website',
      note: 'Synthetic note',
      createTimestamp: Date.now(),
      isActive: true,
      forwardToEmail: 'synthetic@example.test',
    },
  ];
  let fills = 0,
    reads = 0;
  const snapshot = () => ({
    emails,
    forwardTo: 'synthetic@example.test',
    forwardToEmails: [],
    fetchedAt: Date.now(),
  });
  window.chrome = {
    runtime: {
      id: 'qa-extension',
      lastError: undefined,
      onMessage: runtimeMessages,
      getManifest: () => ({ version: '1.2.21' }),
      getURL: (value) => new URL(value, location.origin).href,
      openOptionsPage: (cb) => respond(undefined, cb),
      sendMessage(message, cb) {
        let result = { ok: true };
        if (message.type === 'getState' || message.type === 'connect')
          result = { ok: true, state: 'unlocked' };
        if (message.type === 'inlineLogins') result = { ok: true, locked: false, logins: [] };
        if (message.type === 'hme:inline-state') result = { ok: true, ready: true };
        if (message.type === 'hme:create-for-site') result = { ok: true, hme: 'synthetic@icloud.com' };
        if (message.type === 'getLogins')
          result = {
            ok: true,
            logins: [
              { username: 'Admin', sites: ['example.test'] },
              { username: 'admin', sites: ['example.test'] },
            ],
          };
        if (message.type === 'getOtpItems')
          result = {
            ok: true,
            items: [{ username: 'Admin', domain: 'example.test' }],
          };
        if (message.type === 'fillOnPage') {
          fills++;
          result = {
            ok: true,
            filled: false,
            detail: {
              username: message.loginName.username,
              password: 'Synthetic-not-a-real-password1!',
              website: 'example.test',
            },
          };
        }
        if (message.type === 'fillOtpOnPage') {
          fills++;
          result = {
            ok: true,
            filled: false,
            detail: {
              username: 'Admin',
              domain: 'example.test',
              code: '123456',
              fetchedAt: Date.now(),
              expiresAt: Date.now() + 30000,
            },
          };
        }
        if (message.type === 'getOtpForLoginDetails')
          result = { ok: true, item: null };
        if (message.type === 'hme:manager') {
          const [id, label, note] = message.args || [];
          if (message.operation === 'snapshot') result.result = snapshot();
          if (message.operation === 'list') {
            reads++;
            result.result = {
              hmeEmails: emails,
              selectedForwardTo: 'synthetic@example.test',
              forwardToEmails: [],
            };
          }
          if (message.operation === 'metadata')
            emails = emails.map((email) =>
              email.anonymousId === id ? { ...email, label, note } : email
            );
          if (
            message.operation === 'deactivate' ||
            message.operation === 'reactivate'
          )
            emails = emails.map((email) =>
              email.anonymousId === id
                ? { ...email, isActive: message.operation === 'reactivate' }
                : email
            );
          if (message.operation === 'delete')
            emails = emails.filter((email) => email.anonymousId !== id);
          if (!['snapshot', 'list'].includes(message.operation))
            queueMicrotask(() =>
              runtimeMessages.emit({
                type: 'hme:list-changed',
                key: message.key,
              })
            );
        }
        document.documentElement.dataset.fillReads = String(fills);
        document.documentElement.dataset.listReads = String(reads);
        return respond(result, cb);
      },
    },
    storage: {
      local: storage(local, 'local'),
      session: storage(session, 'session'),
      onChanged: storageChanges,
    },
    tabs: {
      query: (...args) =>
        respond([{ id: 1, url: 'https://example.test/login' }], args.at(-1)),
      sendMessage: (...args) =>
        respond({ ok: true, filled: false }, args.at(-1)),
    },
    i18n: { getUILanguage: () => 'en', getMessage: (name) => name },
    contextMenus: { update: (...args) => respond(undefined, args.at(-1)) },
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, options) => {
    if (new URL(url, location.href).origin === location.origin)
      return realFetch(url, options);
    if (String(url).endsWith('/validate'))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            webservices: services,
            dsInfo: { dsid: 'synthetic-account' },
          }),
          { status: 200 }
        )
      );
    return Promise.reject(
      new TypeError('External requests disabled in synthetic preview')
    );
  };
})();
