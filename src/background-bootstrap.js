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

async function repairToolbarAction({ repairExistingTabs = false } = {}) {
  // Restore manifest-equivalent global state first.
  try { await chrome.action.enable(); } catch (_) {}
  try { await chrome.action.setPopup({ popup: TOOLBAR_POPUP }); } catch (_) {}

  if (!repairExistingTabs) return;
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => repairOneTab(tab.id)));
  } catch (_) {}
}

// Run before loading the application background code, so unrelated initialization cannot
// strand the toolbar action. Repeat for lifecycle events and newly created/updated tabs so a
// stale tab-specific popup override from an older dev build cannot survive.
repairToolbarAction({ repairExistingTabs: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  repairToolbarAction({ repairExistingTabs: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  repairToolbarAction({ repairExistingTabs: true }).catch(() => {});
});
chrome.tabs.onCreated.addListener((tab) => { repairOneTab(tab.id).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId) => { repairOneTab(tabId).catch(() => {}); });
chrome.tabs.onActivated.addListener(({ tabId }) => { repairOneTab(tabId).catch(() => {}); });

try {
  importScripts('background.bundle.js');
} catch (error) {
  console.error('[Apple All-In-One] background bundle failed to initialize', error);
}
