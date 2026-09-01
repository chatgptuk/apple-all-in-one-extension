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
});
