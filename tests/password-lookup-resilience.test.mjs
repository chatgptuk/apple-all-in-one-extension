import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

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

test('password lookup failures cannot be rendered as an empty vault', () => {
  const popup = readProjectFile('src/pages/Popup/Popup.tsx');
  const background = readProjectFile('src/passwords/core/background.js');
  const inline = readProjectFile('src/passwords/inline.js');

  assert.match(popup, /siteLoadSequence/);
  assert.match(popup, /!siteItemsLoading && !error && !logins\.length && !otps\.length/);
  assert.match(popup, /Could not query Apple Passwords/);
  assert.match(background, /Apple Passwords lookup failed/);
  assert.match(inline, /state\.lookupError/);
});

test('native lookup retries transient empty replies and tolerates response key variants', () => {
  const protocol = readProjectFile('src/passwords/core/protocol.js');

  assert.match(protocol, /EMPTY_LOOKUP_RETRY_MS/);
  assert.match(protocol, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(protocol, /response\?\.Entries \?\? response\?\.entries/);
  assert.match(protocol, /entry\?\.USR \?\? entry\?\.username \?\? entry\?\.user/);
});
