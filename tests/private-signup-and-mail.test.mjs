import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const readProjectFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const loadVerificationCodeExtractor = () => {
  const source = readProjectFile('src/mailVerificationCode.ts');
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { exports: module.exports, module });
  return module.exports.extractMailVerificationCode;
};

const loadICloudClientModule = (fetchImpl) => {
  const source = readProjectFile('src/iCloudClient.ts');
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    AbortController,
    clearTimeout,
    console,
    exports: module.exports,
    fetch: fetchImpl,
    module,
    setTimeout,
  });
  return module.exports;
};

test('mail verification-code detection favors contextual codes and rejects ordinary numbers', () => {
  const extract = loadVerificationCodeExtractor();

  assert.equal(extract('Your verification code is 482913.'), '482913');
  assert.equal(extract('验证码：8392，请勿告诉他人'), '8392');
  assert.equal(extract('Use one-time code 12345678 to continue'), '12345678');
  assert.equal(
    extract('Your order 123456789 shipped on 2026-08-31'),
    undefined
  );
  assert.equal(extract('Invoice 48291 is ready'), undefined);
  assert.equal(extract('Login activity recorded on 2026-08-31'), undefined);
});

test('recent Hide My Email messages are user-triggered and not persisted', () => {
  const client = readProjectFile('src/iCloudMailClient.ts');
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');

  assert.match(client, /listRecentMessagesForAlias/);
  assert.match(client, /messageMetadataList/);
  assert.match(popup, /onClick=\{\(\) => void loadRecentMail\(\)\}/);
  assert.match(popup, /Message previews are not saved by the extension/);
  assert.doesNotMatch(popup, /setBrowserStorageValue\('recentMail'/);
});

test('Hide My Email address lists survive tab switches and popup reopens without refetching', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');

  assert.match(popup, /HME_LIST_CACHE_TTL/);
  assert.match(popup, /const hmeListCache = new Map/);
  assert.match(popup, /browser\.storage\.session\.get/);
  assert.match(popup, /browser\.storage\.session\.set/);
  assert.match(popup, /cacheIsFresh[\s\S]*if \(cacheIsFresh\) return/);
  assert.match(popup, /const hmeClient = useMemo/);
  assert.match(popup, /invalidateHmeListSnapshot/);
  assert.match(popup, /onCreated=\{\(\) => \{[\s\S]*setRefreshKey/);
});

test('Hide My Email authorization failures clear stale popup sessions before surfacing', async () => {
  for (const status of [401, 403, 429]) {
    const authenticationFailures = [];
    const { default: ICloudClient } = loadICloudClientModule(async () => ({
      ok: false,
      status,
    }));
    const client = new ICloudClient(
      'https://setup.icloud.com/setup/ws/1',
      undefined,
      undefined,
      (error) => authenticationFailures.push(error.status)
    );

    await assert.rejects(
      client.request('GET', 'https://p170-maildomainws.icloud.com/v2/hme/list'),
      (error) => error.status === status
    );
    assert.deepEqual(authenticationFailures, status === 429 ? [] : [status]);
  }

  const popup = readProjectFile('src/pages/Popup/Popup.tsx');
  assert.match(popup, /handleHmeAuthenticationFailure/);
  assert.match(
    popup,
    /constructClient\(clientState, handleHmeAuthenticationFailure\)/
  );
  assert.match(popup, /setHmeDiscoveryDone\(false\)/);
  assert.match(popup, /invalidateHmeListSnapshot/);
  assert.match(popup, /setClientState\(undefined\)/);
});

test('smart signup keeps alias discovery in the extension and requires a chooser action', () => {
  const background = readProjectFile('src/pages/Background/index.ts');
  const content = readProjectFile('src/passwords/content.js');
  const inline = readProjectFile('src/passwords/inline.js');

  assert.match(background, /findExistingAliasForHost/);
  assert.match(background, /message\.type === 'hme:create-for-site'/);
  assert.match(content, /appleSignInControl/);
  assert.match(content, /msg\.type === 'smart-signup'/);
  assert.match(
    content,
    /lastGenerated = \{ host: location\.hostname, password: msg\.password/
  );
  assert.match(inline, /send\('smart-signup'/);
  assert.match(inline, /send\('use-apple-sign-in'/);
  assert.match(inline, /const separator = '!'/);
  assert.match(inline, /\.join\(separator\)/);
  assert.doesNotMatch(inline, /\.join\('-'\)/);
});

test('multi-step signup pages keep Hide My Email reuse eligible across SPA updates', () => {
  const content = readProjectFile('src/passwords/content.js');

  assert.match(content, /const SIGNUP_ROUTE =/);
  assert.match(content, /register\|registration/);
  assert.match(content, /const signupFields = new WeakSet\(\)/);
  assert.match(content, /if \(signupFields\.has\(el\)\) return true/);
  assert.match(content, /if \(SIGNUP_ROUTE\.test\(route\)\) return remember\(true\)/);
  assert.match(content, /h1, h2, h3, \[role="heading"\], legend/);
});

test('saved logins suppress signup extras and standalone inline Hide My Email is removed', () => {
  const background = readProjectFile('src/pages/Background/index.ts');
  const content = readProjectFile('src/passwords/content.js');
  const inline = readProjectFile('src/passwords/inline.js');

  const savedLoginBranch = inline.indexOf('if (state.logins?.length)');
  const signupBranch = inline.indexOf('let hasSection = appendSmartSignup(state)');
  assert.ok(savedLoginBranch >= 0 && savedLoginBranch < signupBranch);
  assert.match(content, /canSmartSignup: !hasSavedLogins/);
  assert.match(content, /hasAppleSignIn: !hasSavedLogins/);
  assert.match(content, /canGenerate: !hasSavedLogins/);
  assert.doesNotMatch(inline, /makeHideEmailRow|hme-(?:fill-existing|generate|use)/);
  assert.doesNotMatch(content, /msg\.type === 'hme-(?:fill-existing|generate|use)'/);
  assert.doesNotMatch(background, /message\.type === 'hme:(?:generate|reserve)'/);
  assert.match(background, /contextMenus\.onClicked\.addListener/);
  assert.match(background, /message\.type === 'hme:create-for-site'/);
});
