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
  if (params.get('many') === '1') emails = Array.from({ length: 660 }, (_, index) => ({
    ...emails[0], anonymousId: `qa-${index}`, hme: `synthetic-${index}@icloud.com`,
    domain: index % 3 === 0 ? 'example.test' : 'other.test',
    label: index === 684 ? 'Search beyond first page' : `Example ${index + 1}`,
    createTimestamp: Date.now() - index * 86400000, isActive: index % 4 !== 0,
  }));
  const siteLinks = {};
  let sitePreferences = { suggestions: 'automatic', privateSignup: true };
  let fills = 0,
    reads = 0;
  const snapshot = () => ({
    emails,
    forwardTo: 'synthetic@example.test',
    forwardToEmails: [],
    fetchedAt: Date.now(),
  });
  if (params.get('accounts') === '1') document.addEventListener('DOMContentLoaded', () => {
    const switcher = document.createElement('button');
    switcher.textContent = 'Switch synthetic iCloud account';
    switcher.id = 'qa-switch-account';
    switcher.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:10px';
    switcher.onclick = () => {
      emails = [{ ...emails[0], anonymousId: 'account-b-address', hme: 'account-b@icloud.com', label: 'Account B address', note: 'Account B only' }];
      const oldValue = local.clientState;
      local.clientState = { ...oldValue, dsid: 'synthetic-account-b' };
      storageChanges.emit({ clientState: { oldValue, newValue: local.clientState } }, 'local');
    };
    document.body.append(switcher);
  });
  if (params.get('links') === '1') document.addEventListener('DOMContentLoaded', () => {
    const linker = document.createElement('button');
    linker.textContent = 'Simulate website association from another window';
    linker.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:10px';
    linker.onclick = () => {
      siteLinks['qa-1'] = ['example.test'];
      runtimeMessages.emit({ type: 'hme:list-changed', key: `${local.clientState.setupUrl}\n${local.clientState.dsid}` });
    };
    document.body.append(linker);
  });
  window.chrome = {
    runtime: {
      id: 'qa-extension',
      lastError: undefined,
      onMessage: runtimeMessages,
      getManifest: () => ({ version: '1.3.1' }),
      getURL: (value) => new URL(value, location.origin).href,
      openOptionsPage: (cb) => respond(undefined, cb),
      sendMessage(message, cb) {
        let result = { ok: true };
        if (message.type === 'getState' || message.type === 'connect')
          result = { ok: true, state: 'unlocked' };
        if (message.type === 'getSitePreferences' || message.type === 'setSitePreferences') {
          if (message.preferences) sitePreferences = message.preferences;
          result = { ok: true, host: 'example.test', preferences: sitePreferences };
        }
        if (message.type === 'getDiagnostics') result = { ok: true, report: {
          version: 'preview', passwordState: 'unlocked', icloudState: 'signed_in',
          pendingSaveCount: 0, recentEvents: [],
        } };
        if (message.type === 'resolveSave') result = { ok: true, saved: false, status: params.get('saveStatus') || 'submitted' };
        if (message.type === 'inlineLogins') result = { ok: true, locked: false, logins: [] };
        if (message.type === 'hme:inline-state') result = { ok: true, ready: true };
        if (message.type === 'hme:create-for-site') result = { ok: true, hme: 'synthetic@icloud.com' };
        if (message.type === 'getLogins')
          result = {
            ok: true,
            logins: [
              { username: 'Admin', sites: ['example.test'], sourceWebsite: 'example.test', match: 'exact' },
              { username: 'admin', sites: ['example.test'], sourceWebsite: 'related.example.test', match: 'related' },
            ],
          };
        if (message.type === 'getOtpItems')
          result = {
            ok: true,
            items: [{ username: 'Admin', domain: 'example.test' }],
          };
        if (message.type === 'fillOnPage') {
          if (message.mode !== 'details') fills++;
          result = {
            ok: true,
            filled: false,
            ...(message.mode === 'details' ? {} : { reason: 'no_login_field' }),
            detail: {
              username: message.loginName.username,
              password: 'Synthetic-not-a-real-password1!',
              website: 'example.test',
            },
          };
        }
        if (message.type === 'fillOtpOnPage') {
          if (message.mode !== 'details') fills++;
          result = {
            ok: true,
            filled: false,
            ...(message.mode === 'details' ? {} : { reason: 'no_otp_field' }),
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
          if (message.operation === 'site-links') result.result = structuredClone(siteLinks);
          if (message.operation === 'site-links-set') { siteLinks[id] = label; result.result = label; }
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
          if (!['snapshot', 'list', 'site-links'].includes(message.operation))
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
      create: (options, cb) => respond({ id: 2, url: options.url }, cb),
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
