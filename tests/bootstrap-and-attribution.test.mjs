import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const readProjectFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('background bootstrap still loads the application when contextMenus.onShown is unavailable', () => {
  const importedScripts = [];
  const ignoredEvent = { addListener() {} };
  const sandbox = {
    chrome: {
      action: {
        enable: async () => {},
        setPopup: async () => {},
      },
      contextMenus: {},
      runtime: {
        onInstalled: ignoredEvent,
        onStartup: ignoredEvent,
      },
      scripting: { executeScript: async () => {} },
      tabs: {
        onActivated: ignoredEvent,
        onCreated: ignoredEvent,
        onUpdated: ignoredEvent,
        query: async () => [],
      },
    },
    console,
    importScripts(path) {
      importedScripts.push(path);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(readProjectFile('build/background-bootstrap.js'), sandbox);

  assert.deepEqual(importedScripts, ['background.bundle.js']);
});

test('background startup repairs a missing Hide My Email context menu', () => {
  const source = readProjectFile('src/pages/Background/index.ts');

  assert.match(source, /setupContextMenu\(\)\.catch\(console\.debug\)/);
  assert.match(source, /contextMenus\.update\(CONTEXT_MENU_ITEM_ID, menuProperties\)/);
  assert.match(source, /contextMenus\.create\(\{[\s\S]*contexts: \['editable'\]/);
});

test('popup favicon discovery never downloads arbitrary website documents', () => {
  const source = readProjectFile('src/pages/Popup/Popup.tsx');

  assert.doesNotMatch(source, /new DOMParser\s*\(/);
  assert.doesNotMatch(source, /const canonical\s*=\s*`https:\/\/\$\{domain\}\/`/);
  assert.doesNotMatch(source, /pageResponse/);
});

test('project documentation attributes OTP management to Apple All-In-One', () => {
  const readme = readProjectFile('README.md');
  const notices = readProjectFile('THIRD_PARTY_NOTICES.md');
  const userGuide = readProjectFile('src/pages/Userguide/Userguide.tsx');
  const background = readProjectFile('src/pages/Background/index.ts');

  assert.doesNotMatch([readme, notices, userGuide, background].join('\n'), /v0\.53/);
  assert.match(readme, /verification-code discovery[\s\S]*implemented by Apple All-In-One/);
  assert.match(notices, /verification-code discovery[\s\S]*project additions/);
  assert.match(userGuide, /fill one only after you choose it/);
});
