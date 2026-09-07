// Tiny MV3 bootstrap for Apple All-In-One.
// Keep toolbar-action recovery independent from the heavier Passwords/iCloud background bundle.
// Older development builds used tab-scoped action state and popup overrides. Because this
// extension intentionally keeps a fixed ID, unpacked reloads/reinstalls can encounter tabs
// that still carry those stale per-tab settings. Repair both enabled state AND popup target.

const TOOLBAR_POPUP = 'popup.html';

async function repairOneTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await chrome.action.enable(tabId); } catch (_) {}
  try { await chrome.action.setPopup({ tabId, popup: TOOLBAR_POPUP }); } catch (_) {}
}

const REPAIR_CONTENT_SCRIPTS = [
  'passwordsContent.bundle.js',
  'contentScript.bundle.js',
];

async function injectContentScripts(tabId, frameId) {
  if (!Number.isInteger(tabId)) return;
  await Promise.all(REPAIR_CONTENT_SCRIPTS.map(async (file) => {
    try {
      await chrome.scripting.executeScript({
        target: {
          tabId,
          ...(Number.isInteger(frameId) ? { frameIds: [frameId] } : { allFrames: true }),
        },
        files: [file],
      });
    } catch (_) {}
  }));
}

async function repairInstalledTabs() {
  // Install/update migration only. A worker wake must not fan out across every
  // tab; explicit fills recover missing receivers in the main background.
  try { await chrome.action.enable(); } catch (_) {}
  try { await chrome.action.setPopup({ popup: TOOLBAR_POPUP }); } catch (_) {}
  try {
    const tabs = await chrome.tabs.query({});
    let nextTab = 0;
    await Promise.all(Array.from({ length: Math.min(4, tabs.length) }, async () => {
      while (nextTab < tabs.length) {
        const tab = tabs[nextTab++];
        await repairOneTab(tab.id);
        // Restricted and discarded tabs do not need an eager recovery attempt.
        if (!tab.discarded && /^https?:\/\//i.test(tab.url || '')) await injectContentScripts(tab.id);
      }
    }));
  } catch (_) {}
}

// Load the real background first. Optional repair hooks below must never be able to prevent
// context-menu registration or the rest of the extension from starting.
try {
  importScripts('background.bundle.js');
} catch (error) {
  console.error('[Apple All-In-One] background bundle failed to initialize', error);
}

let installationRepair;
chrome.runtime.onInstalled.addListener((details) => {
  if (details?.reason !== 'install' && details?.reason !== 'update') return;
  installationRepair ||= repairInstalledTabs().finally(() => { installationRepair = undefined; });
});
