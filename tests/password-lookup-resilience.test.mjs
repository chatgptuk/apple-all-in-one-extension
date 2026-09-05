import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { orderLoginsForHost } from '../src/passwords/core/login-order.js';
import { createPasswordCache } from '../src/passwords/core/password-cache.js';
import { ApplePasswords } from '../src/passwords/core/protocol.js';

const readProjectFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('background bootstrap repairs both password and Hide My Email scripts in existing tabs', async () => {
  const injectedFiles = [];
  const event = () => ({ addListener() {} });
  const sandbox = {
    chrome: {
      action: {
        enable: async () => {},
        setPopup: async () => {},
      },
      runtime: {
        onInstalled: event(),
        onStartup: event(),
      },
      tabs: {
        query: async () => [{ id: 42 }],
        onCreated: event(),
        onUpdated: event(),
        onActivated: event(),
      },
      scripting: {
        executeScript: async ({ files }) => injectedFiles.push(...files),
      },
    },
    console,
    importScripts() {},
    Promise,
  };

  vm.runInNewContext(readProjectFile('src/background-bootstrap.js'), sandbox);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(injectedFiles.includes('passwordsContent.bundle.js'));
  assert.ok(injectedFiles.includes('contentScript.bundle.js'));
});

test('password chooser keeps existing-alias discovery off the initial lookup path', () => {
  const content = readProjectFile('src/passwords/content.js');

  assert.match(content, /function refreshExistingHme\(anchor, token\)/);
  assert.match(content, /'hme:inline-state', wantAlias: false/);
  assert.match(content, /'hme:inline-state', wantAlias: true/);
  assert.doesNotMatch(
    content,
    /Promise\.all\(\[[\s\S]{0,500}'hme:inline-state', wantAlias: isHideEmailField/
  );
});

test('content messages absorb an invalidated extension context and retire the stale UI', () => {
  const content = readProjectFile('src/passwords/content.js');

  assert.match(content, /function isExtensionContextError/);
  assert.match(content, /function stopInvalidatedContentScript/);
  assert.match(content, /async function sendRuntimeMessage/);
  assert.match(content, /Extension context invalidated/);
  assert.equal((content.match(/chrome\.runtime\.sendMessage/g) || []).length, 1);
  assert.match(content, /offerSeq \+= 1/);
  assert.match(content, /try \{ closeUi\(\); \} catch/);
});

test('password lookup failures cannot be rendered as an empty vault', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');
  const background = readProjectFile('src/passwords/core/background.js');
  const inline = readProjectFile('src/passwords/inline.js');

  assert.match(popup, /siteLoadSequence/);
  assert.match(popup, /!siteItemsLoading && !otpItemsLoading && !error && !logins\.length && !otps\.length/);
  assert.match(popup, /Could not query Apple Passwords/);
  assert.match(background, /Apple Passwords lookup failed/);
  assert.match(inline, /state\.lookupError/);
});

test('popup does not make verification-code metadata block the password list', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');

  assert.doesNotMatch(
    popup,
    /Promise\.all\(\[[\s\S]{0,300}type: 'getLogins'[\s\S]{0,300}type: 'getOtpItems'/
  );
  assert.match(popup, /setSiteItemsLoading\(false\)[\s\S]{0,500}setOtpItemsLoading\(true\)/);
  assert.match(popup, /10_000/);
});

test('recent password fills reuse the same in-memory credential without extending it forever', () => {
  const background = readProjectFile('src/passwords/core/background.js');
  let clock = 0;
  const cache = createPasswordCache({
    idleTtlMs: 120_000,
    maxTtlMs: 300_000,
    now: () => clock,
  });
  const credential = { username: 'Person@example.com', password: 'secret' };

  cache.set('LOGIN.EXAMPLE.COM', credential);
  clock = 110_000;
  assert.equal(cache.get('login.example.com', ' person@example.com\u200B '), null);
  assert.equal(cache.get('login.example.com', 'Person@example.com'), credential);
  clock = 220_000;
  assert.equal(cache.get('login.example.com', 'PERSON@EXAMPLE.COM'), null);
  assert.equal(cache.get('login.example.com', 'Person@example.com'), credential);
  clock = 300_001;
  assert.equal(cache.get('login.example.com', 'Person@example.com'), null);
  assert.match(
    background,
    /createPasswordCache\(\{ idleTtlMs: 2 \* 60_000, maxTtlMs: 5 \* 60_000 \}\)/
  );
  assert.match(background, /if \(s !== State\.Unlocked\) pwCacheClear\(\)/);
});

test('password fill cache expires after inactivity and clears on demand', () => {
  let clock = 0;
  const cache = createPasswordCache({
    idleTtlMs: 120_000,
    maxTtlMs: 300_000,
    now: () => clock,
  });
  const credential = { username: 'person', password: 'secret' };

  cache.set('example.com', credential);
  clock = 120_001;
  assert.equal(cache.get('example.com', 'person'), null);

  clock = 130_000;
  cache.set('example.com', credential);
  cache.clear();
  assert.equal(cache.get('example.com', 'person'), null);
});

test('popup saved-login clicks fill the page and open a popup-only secret detail card', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');
  const background = readProjectFile('src/passwords/core/background.js');

  assert.match(popup, /fillAndShowLogin/);
  assert.match(popup, /Fill page and open details/);
  assert.match(popup, /password-detail-card/);
  assert.match(popup, /getOtpForLoginDetails/);
  assert.match(popup, /Show Code', '显示验证码/);
  assert.doesNotMatch(popup, /void loadLoginOtp\(res\.detail/);
  assert.match(background, /case "fillOnPage"[\s\S]*detail,[\s\S]*case "getOtpForLoginDetails"/);
  assert.match(background, /isFromOwnUi\(sender\)/);
  assert.doesNotMatch(
    background,
    /CONTENT_ALLOWED = new Set\(\[[^\]]*getOtpForLoginDetails/
  );
  assert.match(
    background,
    /const chosen = selectAccountCode\(items, msg\.username\)/
  );
});

test('standalone verification-code clicks fill and reveal from one secret read', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');
  const background = readProjectFile('src/passwords/core/background.js');

  assert.match(popup, /fillAndShowOtp/);
  assert.match(popup, /same Touch ID-authorized action used to fill the page/);
  assert.match(background, /case "fillOtpOnPage"[\s\S]*const detail = \{[\s\S]*code: String\(chosen\.code\)[\s\S]*detail,/);
  assert.match(
    background,
    /const chosen = selectAccountCode\(items, msg\.username\)/
  );
  assert.doesNotMatch(popup, /fillAndShowOtp[\s\S]{0,900}window\.close\(\)/);
});

test('expanded password and verification-code rows collapse without another secret request', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');

  assert.match(
    popup,
    /onClick=\{\(\) => expanded \? clearLoginDetail\(\) : void fillAndShowLogin\(login, loginKey\)\}/
  );
  assert.match(
    popup,
    /onClick=\{\(\) => expanded \? clearLoginDetail\(\) : void fillAndShowOtp\(item, otpKey\)\}/
  );
  assert.match(popup, /expanded \? tr\('Collapse details', '收起详情'\)/);
});

test('popup exposes unlock flows without a manual password-session lock action', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');
  const background = readProjectFile('src/passwords/core/background.js');

  assert.match(popup, /Unlock Apple Passwords/);
  assert.doesNotMatch(popup, /Lock Passwords Session|锁定密码会话|type: 'disconnect'/);
  assert.doesNotMatch(background, /case "disconnect"/);
});

test('native metadata lookups can expire while queued behind an interactive secret read', async () => {
  const client = new ApplePasswords();
  client._lock = new Promise(() => {});
  let ran = false;

  await assert.rejects(
    client._withLock(() => { ran = true; }, { queueTimeoutMs: 10 }),
    /busy; retry the lookup/,
  );
  assert.equal(ran, false);
});

test('exact Apple Passwords site matches sort ahead of related-domain and MRU entries', () => {
  const ordered = orderLoginsForHost(
    'prson-srpel.apps.cic.gc.ca',
    [
      { username: 'tracker-account', sites: ['https://ircc-tracker-suivi.apps.cic.gc.ca/login'] },
      { username: 'exact-account', sites: [{ url: 'https://prson-srpel.apps.cic.gc.ca/en/login' }] },
      { username: 'other-account', sites: { 'another.apps.cic.gc.ca': true } },
    ],
    ['tracker-account'],
  );

  assert.deepEqual(
    ordered.map((login) => login.username),
    ['exact-account', 'tracker-account', 'other-account'],
  );
});

test('MRU and helper order remain fallback ordering when there is no exact site match', () => {
  const ordered = orderLoginsForHost(
    'unknown.apps.cic.gc.ca',
    [
      { username: 'first', sites: ['first.apps.cic.gc.ca'] },
      { username: 'recent', sites: ['second.apps.cic.gc.ca'] },
      { username: 'last', sites: ['third.apps.cic.gc.ca'] },
    ],
    ['recent'],
  );

  assert.deepEqual(
    ordered.map((login) => login.username),
    ['recent', 'first', 'last'],
  );
});

test('native lookup retries transient empty replies and tolerates response key variants', () => {
  const protocol = readProjectFile('src/passwords/core/protocol.js');

  assert.match(protocol, /EMPTY_LOOKUP_RETRY_MS/);
  assert.match(protocol, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(protocol, /response\?\.Entries \?\? response\?\.entries/);
  assert.match(protocol, /entry\?\.USR \?\? entry\?\.username \?\? entry\?\.user/);
});
