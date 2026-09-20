// Owns the native connection + SRP session. The connected native port keeps the MV3 worker alive.

import { ApplePasswords, State } from "./protocol.js";
import { orderLoginsForHost, describeLoginCandidatesForHost } from "./login-order.js";
import { createPasswordCache } from "./password-cache.js";
import { accountKey, selectAccountCode } from './account-identity.js';
import { createPendingSaveQueue } from './pending-saves.js';
import { createNativeDiagnosticJournal } from './native-diagnostics.js';
import { validPasswordRequest, failureReason, failureMessage, failureResult, normalizeSitePreferences } from '../message-contracts.js';
import { SITE_PREFERENCES_KEY, sitePreferencesFor, validSiteHost } from '../site-preferences.js';

const nativeDiagnosticJournal = createNativeDiagnosticJournal(chrome.storage.session);
const client = new ApplePasswords({ onDiagnosticEvent: nativeDiagnosticJournal.record });
const recentDiagnosticEvents = [];
const saveStatusByTab = new Map();
function recordDiagnostic(operation, reason) {
  // Never retain URLs, account names, native payloads or exception messages.
  const knownOperations = new Set(['inlineFill', 'inlineFillOtp', 'inlineLogins', 'inlineOtpItems', 'fillOnPage', 'fillOtpOnPage', 'getLogins', 'getOtpItems', 'getOtpForLoginDetails', 'refreshAndRefill', 'resolveSave']);
  recentDiagnosticEvents.push({ operation: knownOperations.has(operation) ? operation : 'unknown', reason: failureReason({ reason }), at: Date.now() });
  if (recentDiagnosticEvents.length > 20) recentDiagnosticEvents.shift();
}
function setSaveStatus(tabId, status) {
  saveStatusByTab.set(tabId, { status, at: Date.now() });
  while (saveStatusByTab.size > 32) saveStatusByTab.delete(saveStatusByTab.keys().next().value);
  broadcast({ type: 'password-save-status', status });
}

client.onStateChange((s) => {
  // any state other than unlocked means the session/keys are gone - drop the plaintext cache
  if (s !== State.Unlocked) pwCacheClear();
  broadcast({ type: "state", state: s });
});

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// most-recently-used login per host (in-memory), so the dropdown floats your usual account up
const mruByHost = new Map(); // host -> [exact username, most recent first]
function recordMru(host, username) {
  if (!host || !username) return;
  const u = accountKey(username);
  const arr = (mruByHost.get(host) || []).filter((x) => x !== u);
  arr.unshift(u);
  mruByHost.set(host, arr.slice(0, 10));
  while (mruByHost.size > 128) mruByHost.delete(mruByHost.keys().next().value);
}
function orderForHost(host, logins) {
  return orderLoginsForHost(host, logins, mruByHost.get(host) || []);
}

// which account a submitted password attaches to ("" lets the native sheet ask, null saves nothing); in the background so a redirect cant lose it
function pickSaveTarget({ host, existing, detected, generated, newPwCtx }) {
  const matched = detected && existing.find((u) => accountKey(u) === accountKey(detected));
  // update only on a new password, stay quiet on a plain re-login
  if (matched) return generated || newPwCtx ? matched : null;
  if (detected) return detected;
  // no username on a reset with saved account(s): attach to the MRU one, apple's sheet lets the user re-pick
  if (newPwCtx && existing.length) {
    return orderForHost(host, existing.map((u) => ({ username: u })))[0].username;
  }
  if (generated) return "";
  return null;
}

// new-password saves that arrived while locked; a reset can navigate away, so stash and flush on unlock
const pendingSaves = createPendingSaveQueue({ onDiscard: (metadata, reason) => {
  if (reason === 'expired' || reason === 'evicted') setSaveStatus(metadata.tabId, 'expired');
} });
function queuePendingSave(save) {
  pendingSaves.enqueue(save);
  setSaveStatus(save.tabId, 'waiting_unlock');
}
let flushingPendingSaves = false;
async function flushPendingSaves() {
  if (flushingPendingSaves || !client.ready || !pendingSaves.size) return;
  flushingPendingSaves = true;
  try {
  while (client.ready && pendingSaves.size) {
    const s = pendingSaves.takeNext();
    if (!s) break;
    try {
      if (Date.now() >= s.expiresAt) { setSaveStatus(s.tabId, 'expired'); continue; }
      const existing = (await client.getLoginNamesForURL(s.tabId, s.frameUrl)).map((l) => l.username).filter(Boolean);
      if (Date.now() >= s.expiresAt) { setSaveStatus(s.tabId, 'expired'); continue; }
      if (!client.ready) { pendingSaves.requeue(s); break; }
      const target = pickSaveTarget({ ...s, existing });
      if (target === null) continue;
      await client.saveLogin(s.tabId, s.frameUrl, target, s.password);
      setSaveStatus(s.tabId, 'submitted');
    } catch (error) {
      setSaveStatus(s.tabId, 'failed');
      recordDiagnostic('resolveSave', failureReason(error));
      // Never silently replay a native save: the user may already have confirmed
      // a system prompt even when its response was lost.
    } finally { s.password = ''; }
  }
  } finally { flushingPendingSaves = false; }
}

const normUsername = accountKey;

// helper returns the same username several times (www + apex entries, or a stray-space dupe).
// fills look up by username, so extra rows only ever fetch the same credential - drop them
function uniqueByUsername(logins) {
  const seen = new Set();
  return logins.filter((l) => {
    const k = normUsername(l.username);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// what we last filled per tab, so a popup refresh can re-fill the page with a fresh read
const lastFillByTab = new Map(); // tabId -> { host, username }

// Re-filling the exact host/account shortly after Touch ID reuses the decrypted credential.
// The cache is memory-only, expires after two idle minutes (five minutes maximum), and is
// cleared whenever Apple locks the session, the worker restarts, or the user refreshes.
const pwCache = createPasswordCache({ idleTtlMs: 2 * 60_000, maxTtlMs: 5 * 60_000 });
function pwCacheGet(host, username) {
  return pwCache.get(host, username);
}
function pwCacheSet(host, cred) {
  pwCache.set(host, cred);
}
function pwCacheClear() {
  pwCache.clear();
}

// stuck native call shouldnt leave a UI waiter (inline PIN box) hanging forever
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label || "timed out")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function isMissingReceiverError(error) {
  return /Receiving end does not exist|Could not establish connection|message port closed/i.test(
    String(error?.message ?? error ?? ""),
  );
}

// After an unpacked extension is installed/reloaded, tabs that were already open do not
// automatically receive the new static content script. An explicit toolbar fill should recover
// that tab instead of surfacing Chrome's opaque "Receiving end does not exist" error.
// Injection happens only after a user-triggered fill and only into the requested frame.
async function sendToPasswordContent(tabId, message, frameId = 0, binding) {
  // Re-read the site setting after Touch ID, including cache hits and refills.
  if (message.type === 'fill' || message.type === 'fillOtp') {
    if (!await isPasswordFillAllowed(binding?.expectedHref)) throw new Error('refusing to fill on a non-HTTPS page');
  }
  const options = binding?.documentId ? { documentId: binding.documentId } : { frameId };
  const payload = binding ? { ...message, ...binding } : message;
  try {
    return await chrome.tabs.sendMessage(tabId, payload, options);
  } catch (error) {
    // Never recover a secret delivery into a new document after authentication.
    if (binding) throw error;
    if (!isMissingReceiverError(error) || !chrome.scripting?.executeScript) throw error;
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["passwordsContent.bundle.js"],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  }
}

async function preparePasswordFill(tabId, url, frameId = 0, documentId, requestDocumentToken) {
  if (!await isPasswordFillAllowed(url)) throw new Error('refusing to fill on a non-HTTPS page');
  const expectedOrigin = new URL(url).origin;
  // A content script's sender URL can predate an SPA's locale/route rewrite. Bind
  // preparation to the requesting document, then snapshot its current same-origin
  // URL. Only that exact URL/document/field may receive the secret after Touch ID.
  const requestBinding = documentId || requestDocumentToken ? {
    ...(documentId ? { documentId } : {}),
    ...(requestDocumentToken ? { expectedDocumentToken: requestDocumentToken } : {}),
  } : undefined;
  const target = await sendToPasswordContent(tabId, { type: 'prepareFill', expectedOrigin }, frameId, requestBinding);
  let currentUrl;
  try { currentUrl = new URL(target?.href); } catch {}
  if (!target?.ok || typeof target.documentToken !== 'string' || !target.documentToken ||
      typeof target.targetToken !== 'string' || !target.targetToken ||
      typeof target.href !== 'string' || currentUrl?.origin !== expectedOrigin ||
      (requestDocumentToken && target.documentToken !== requestDocumentToken)) {
    throw new Error('The sign-in page changed. Select the field again.');
  }
  return { expectedOrigin, expectedHref: target.href, expectedDocumentToken: target.documentToken, targetToken: target.targetToken, ...(documentId ? { documentId } : {}) };
}

// A connected native-messaging port already keeps Chrome's worker alive. Remove
// the old perpetual 24-second development alarm; it is not valid in packaged builds.
const KEEPALIVE_ALARM = "open-passwords-keepalive";
chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});

async function ensureConnected({ retryUnavailable = false } = {}) {
  // Ordinary page lookups must not repeatedly start a missing/incompatible host.
  // Opening the popup or pressing Retry explicitly permits another attempt.
  if (client.state === State.Disconnected || (retryUnavailable && client.state === State.NoHelper)) {
    try {
      await client.connect();
    } catch (e) {
      // surfaced via state change (NoHelper / Disconnected)
    }
  }
}

// Native helper connection is intentionally lazy. Connecting during install/startup can
// block the MV3 worker while Chrome is still registering the extension action. Passwords
// messages call ensureConnected() on demand, so the first real Passwords action starts it.

// suppress only chrome password autofill, leave address + credit-card/google pay alone
function suppressChromeAutofill() {
  const svc = chrome.privacy?.services;
  if (!svc?.passwordSavingEnabled) return;
  // user-togglable from the popup, persisted choices. save bubble defaults on, address
  // autofill defaults off (credit-card autofill is never touched, google pay keeps working)
  chrome.storage?.local?.get({ suppressSaveBubble: true, suppressAddressAutofill: false }, (o) => {
    if (chrome.runtime.lastError) return;
    try {
      if (o.suppressSaveBubble) {
        svc.passwordSavingEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      }
      if (o.suppressAddressAutofill && svc.autofillAddressEnabled) {
        svc.autofillAddressEnabled.set({ value: false }, () => void chrome.runtime.lastError);
      }
    } catch (_) {}
  });
}
chrome.runtime.onInstalled.addListener(suppressChromeAutofill);
chrome.runtime.onStartup.addListener(suppressChromeAutofill);
suppressChromeAutofill();

// only the extension's own popup may drive privileged actions (content messages carry sender.tab, the popup never does)
function isFromOwnUi(sender) {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  // The separate HME manager must never drive native password operations.
  if (sender.url) {
    try {
      const url = new URL(sender.url);
      const expected = new URL(chrome.runtime.getURL('popup.html'));
      return url.protocol === expected.protocol && url.host === expected.host &&
        url.pathname === '/popup.html' && url.searchParams.get('manager') !== '1';
    } catch { return false; }
  }
  return true;
}

function isFromHmeManager(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    const expected = new URL(chrome.runtime.getURL('popup.html'));
    return url.protocol === expected.protocol && url.host === expected.host &&
      url.pathname === '/popup.html' && url.searchParams.get('manager') === '1';
  } catch { return false; }
}

// resolve from the real active tab, never from caller input
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensurePopupTarget(tab) {
  const current = await activeTab();
  if (current?.id !== tab.id || current?.url !== tab.url) throw new Error('The sign-in page changed. Select the field again.');
}

function registrableHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Native save behavior remains restricted to HTTPS and local development hosts.
function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host?.endsWith(".localhost") ||
    host?.endsWith(".test")
  );
}

// HTTP filling is allowed by default; only an explicit exact-host setting blocks it.
// A failed storage read must not bypass a user's saved block.
async function isPasswordFillAllowed(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  const stored = await chrome.storage.local.get(SITE_PREFERENCES_KEY);
  return sitePreferencesFor(stored[SITE_PREFERENCES_KEY], parsed.hostname.toLowerCase()).allowHttp;
}

// Internal-only bridge used by the merged Hide My Email module for an explicitly
// opt-in iCloud sign-in recovery. It never exposes a password through runtime messaging
// and never persists plaintext. If Passwords is locked, it returns locked instead of
// silently triggering a new 6-digit pairing challenge. A password read may still cause
// the macOS helper to request Touch ID, which is an Apple-controlled user confirmation.
export async function getCredentialForURLInternal(tabId, url) {
  await ensureConnected();
  if (!client.ready) return { ok: false, locked: true, reason: "passwords_locked" };

  const host = registrableHost(url);
  if (!host || !/^https:\/\//i.test(url)) {
    return { ok: false, reason: "invalid_url" };
  }

  let logins = [];
  try {
    logins = uniqueByUsername(describeLoginCandidatesForHost(host, orderForHost(host, await client.getLoginNamesForURL(tabId, url))));
  } catch (e) {
    return { ok: false, reason: "lookup_failed", error: String(e?.message ?? e) };
  }

  if (!logins.length) return { ok: false, reason: "no_saved_login" };
  if (logins.length > 1) {
    return {
      ok: false,
      reason: "multiple_accounts",
      usernames: logins.map((login) => login.username).filter(Boolean),
    };
  }

  const login = logins[0];
  let cred = pwCacheGet(host, login.username);
  if (!cred) {
    try {
      cred = await client.getPasswordForLoginName(tabId, url, { username: login.username });
      if (cred) pwCacheSet(host, cred);
    } catch (e) {
      return { ok: false, reason: "password_read_failed", error: String(e?.message ?? e) };
    }
  }

  if (!cred?.username || !cred?.password) return { ok: false, reason: "no_saved_login" };
  return {
    ok: true,
    credential: { username: cred.username, password: cred.password },
  };
}

// messages a content script may send - only the sender's own tab/origin, never return a password to the page
const CONTENT_ALLOWED = new Set(["inlineLogins", "inlineFill", "inlineOtpItems", "inlineFillOtp", "requestChallenge", "verifyPin", "resolveSave"]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The merged extension also owns a Hide My Email message namespace. Leave those
  // messages to the HME listeners instead of replying from the Passwords security gate.
  if (typeof msg?.type === "string" && msg.type.startsWith("hme:")) return false;
  if (typeof msg?.type === "number") return false;
  const reply = sendResponse;
  sendResponse = (result) => {
    if ((/Fill|fill|Logins|Otp|resolveSave/.test(msg?.type || '')) &&
        (result?.error || result?.reason || result?.locked)) {
      const reason = result.locked ? 'locked' : failureReason(result);
      result = { ...result, reason, error: failureMessage(reason) };
      recordDiagnostic(msg.type, reason);
    }
    reply(result);
  };
  (async () => {
    try {
      // privileged actions are popup-only; content script gets the inline msgs only
      const fromUi = isFromOwnUi(sender);
      const fromManager = isFromHmeManager(sender);
      const fromContent = !fromManager && sender.id === chrome.runtime.id && sender.tab !== undefined;
      if (!fromUi && !(fromManager && msg?.type === 'getDiagnostics') && !(fromContent && CONTENT_ALLOWED.has(msg?.type))) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }
      if (!validPasswordRequest(msg)) return sendResponse(failureResult({ reason: 'invalid_request' }));

      switch (msg?.type) {
        case 'getSitePreferences':
        case 'setSitePreferences': {
          const tab = await activeTab();
          const host = registrableHost(tab?.url);
          if (!validSiteHost(host) || !/^https?:\/\//i.test(tab?.url || '')) return sendResponse({ ok: false, reason: 'unavailable' });
          const stored = await chrome.storage.local.get(SITE_PREFERENCES_KEY);
          const previous = sitePreferencesFor(stored[SITE_PREFERENCES_KEY], host);
          const preferences = msg.type === 'setSitePreferences'
            ? normalizeSitePreferences({ ...previous, ...msg.preferences })
            : previous;
          if (msg.type === 'setSitePreferences') {
            if (msg.host !== host) return sendResponse(failureResult({ reason: 'target_changed' }));
            await ensurePopupTarget(tab);
            // Do not evict an explicit HTTP block when another website is configured.
            const entries = Object.entries(stored[SITE_PREFERENCES_KEY] || {}).filter(([key]) => validSiteHost(key) && key !== host);
            await chrome.storage.local.set({ [SITE_PREFERENCES_KEY]: Object.fromEntries([...entries, [host, preferences]]) });
          }
          sendResponse({ ok: true, host, preferences });
          break;
        }
        case 'getDiagnostics': {
          const tab = await activeTab();
          const { clientState } = await chrome.storage.local.get('clientState');
          const saved = saveStatusByTab.get(tab?.id);
          sendResponse({ ok: true, report: {
            version: chrome.runtime.getManifest().version,
            passwordState: client.state,
            nativeConnection: { ...client.getDiagnostics(), history: await nativeDiagnosticJournal.read() },
            icloudState: clientState ? 'signed_in' : 'signed_out',
            recentEvents: recentDiagnosticEvents.slice(),
            pendingSaveCount: pendingSaves.size,
          }, saveStatus: saved && Date.now() - saved.at < 10 * 60_000 ? saved : undefined });
          break;
        }
        case "inlineLogins": {
          // login names only (no passwords) for the exact frame that asked, keyed to sender.url not the top tab
          const frameUrl = sender.url;
          if (!frameUrl) return sendResponse({ ok: false, error: "no frame" });
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: true, locked: true, logins: [] });
          try {
            const logins = await client.getLoginNamesForURL(sender.tab?.id, frameUrl);
            sendResponse({
              ok: true,
              locked: false,
              logins: uniqueByUsername(describeLoginCandidatesForHost(registrableHost(frameUrl), orderForHost(registrableHost(frameUrl), logins))),
            });
          } catch (e) {
            sendResponse({
              ok: false,
              locked: false,
              error: `Apple Passwords lookup failed: ${String(e?.message ?? e)}`,
            });
          }
          break;
        }

        case "inlineOtpItems": {
          // Metadata only. Do not fetch or return the current code until the user explicitly
          // picks an item in the isolated extension UI.
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: true, locked: true, items: [] });
          try {
            const items = await client.listOneTimeCodesForURL(sender.tab.id, frameUrl);
            sendResponse({
              ok: true,
              locked: false,
              items: items.map((item) => ({
                username: item.username || "",
                domain: item.domain || "",
                source: item.source || "",
              })),
            });
          } catch (e) {
            sendResponse({
              ok: false,
              locked: false,
              error: `Verification-code lookup failed: ${String(e?.message ?? e)}`,
            });
          }
          break;
        }

        case "inlineFillOtp": {
          // Secret retrieval happens only after a trusted click inside the extension-origin
          // iframe. The code is never returned to that page message caller; it is sent
          // directly back to this exact content-script frame and immediately inserted.
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          if (typeof msg.documentToken !== 'string' || !msg.documentToken) {
            return sendResponse({ ok: false, error: "Refresh this page and select the sign-in field again." });
          }
          const host = registrableHost(frameUrl);
          if (!await isPasswordFillAllowed(frameUrl)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          const binding = await preparePasswordFill(sender.tab.id, frameUrl, frameId, sender.documentId, msg.documentToken);
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });

          const items = await client.getOneTimeCodeForURL(sender.tab.id, binding.expectedHref);
          const chosen = selectAccountCode(items, msg.username, host);
          if (!chosen?.code) return sendResponse({ ok: false, filled: false, error: "No verification code is available for this website." });

          const resp = await sendToPasswordContent(
            sender.tab.id,
            { type: "fillOtp", code: String(chosen.code), expectedHost: host },
            frameId,
            binding,
          );
          sendResponse({
            ok: true,
            filled: !!resp?.filled,
            reason: resp?.reason,
            error: !resp?.filled && resp?.reason === "no_otp_field"
              ? "No verification-code field was found in this sign-in frame."
              : undefined,
          });
          break;
        }

        case "inlineFill": {
          // fetch + fill for the requesting frame's own origin only (frameId), never broadcast - confused-deputy fix
          const frameUrl = sender.url;
          const frameId = sender.frameId;
          if (!frameUrl || sender.tab?.id == null || frameId == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          if (typeof msg.documentToken !== 'string' || !msg.documentToken) {
            return sendResponse({ ok: false, error: "Refresh this page and select the sign-in field again." });
          }
          const host = registrableHost(frameUrl);
          if (!await isPasswordFillAllowed(frameUrl)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          // ignore caller-supplied loginName.sites, query by frame's own host
          // (handled in protocol.js); pass only username through
          const safeLogin = { username: msg.loginName?.username };
          const binding = await preparePasswordFill(sender.tab.id, frameUrl, frameId, sender.documentId, msg.documentToken);
          await ensureConnected();
          // cache hit skips the helper read and its Touch ID; miss reads then caches
          let cred = pwCacheGet(host, safeLogin.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(sender.tab.id, binding.expectedHref, safeLogin);
            if (cred) pwCacheSet(host, cred);
          }
          let filled = false;
          if (cred) {
            const resp = await sendToPasswordContent(
              sender.tab.id,
              {
                type: "fill",
                username: cred.username,
                password: cred.password,
                expectedHost: host,
              },
              frameId, // requesting frame only
              binding,
            );
            filled = !!resp?.filled;
            if (!filled) {
              return sendResponse({
                ok: true,
                filled: false,
                reason: resp?.reason || 'unavailable',
              });
            }
            if (filled) {
              recordMru(host, cred.username);
              lastFillByTab.set(sender.tab.id, { host, username: cred.username });
              while (lastFillByTab.size > 64) lastFillByTab.delete(lastFillByTab.keys().next().value);
            }
          }
          sendResponse({ ok: true, filled });
          break;
        }

        case "resolveSave": {
          // resolve + save here in the background so a submit that navigates cant kill it; native sheet is still the write gate
          const frameUrl = sender.url;
          if (!frameUrl || sender.tab?.id == null) {
            return sendResponse({ ok: false, error: "no frame" });
          }
          const host = registrableHost(frameUrl);
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, reason: 'insecure_save' });
          }
          if (!msg.password) return sendResponse({ ok: false, error: "no password" });
          const detected = (msg.username || "").trim();
          const generated = !!msg.generated;
          const newPwCtx = !!msg.newPwCtx;
          await ensureConnected();

          // locked: cant list or write - stash a new-password save for unlock, a plain re-login isnt worth deferring
          if (!client.ready) {
            if (generated || newPwCtx) {
              queuePendingSave({
                host,
                frameUrl,
                tabId: sender.tab.id,
                detected,
                password: msg.password,
                generated,
                newPwCtx,
              });
            }
            return sendResponse({ ok: true, saved: false, locked: true, status: generated || newPwCtx ? 'waiting_unlock' : undefined });
          }

          const existing = (await client.getLoginNamesForURL(sender.tab.id, frameUrl))
              .map((l) => l.username)
              .filter(Boolean);
          const target = pickSaveTarget({ host, existing, detected, generated, newPwCtx });
          if (target === null) return sendResponse({ ok: true, saved: false, skipped: true });
          await client.saveLogin(sender.tab.id, frameUrl, target, msg.password);
          setSaveStatus(sender.tab.id, 'submitted');
          // Apple's save command does not acknowledge the final user decision.
          sendResponse({ ok: true, saved: false, submitted: true, status: 'submitted' });
          break;
        }

        case "getOtpItems": {
          const tab = await activeTab();
          if (!tab?.url || tab.id == null) return sendResponse({ ok: false, error: "no active tab" });
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: true, locked: true, items: [] });
          try {
            const items = await client.listOneTimeCodesForURL(tab.id, tab.url);
            sendResponse({
              ok: true,
              locked: false,
              items: items.map((item) => ({
                username: item.username || "",
                domain: item.domain || "",
                source: item.source || "",
              })),
            });
          } catch (e) {
            sendResponse({
              ok: false,
              locked: false,
              error: `Verification-code lookup failed: ${String(e?.message ?? e)}`,
            });
          }
          break;
        }

        case "fillOtpOnPage": {
          const tab = await activeTab();
          if (!tab?.url || tab.id == null) return sendResponse({ ok: false, error: "no active tab" });
          const host = registrableHost(tab.url);
          if (!await isPasswordFillAllowed(tab.url)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          const detailsOnly = msg.mode === 'details';
          const binding = detailsOnly ? { expectedHref: tab.url } : await preparePasswordFill(tab.id, tab.url);
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });
          const items = await client.getOneTimeCodeForURL(tab.id, binding.expectedHref);
          const chosen = selectAccountCode(items, msg.username, host);
          if (!chosen?.code) return sendResponse({ ok: false, filled: false, error: "No verification code is available for this website." });
          const fetchedAt = Date.now();
          const detail = {
            username: chosen.username || msg.username || "",
            domain: chosen.domain || host || "",
            code: String(chosen.code),
            fetchedAt,
            expiresAt: (Math.floor(fetchedAt / 30_000) + 1) * 30_000,
          };
          await ensurePopupTarget(tab);
          if (detailsOnly) return sendResponse({ ok: true, filled: false, detail });
          // Toolbar fill targets the top frame. Cross-origin embedded sign-in frames use the
          // inline chooser, which already knows the exact sender.frameId.
          let resp;
          try {
            resp = await sendToPasswordContent(
              tab.id,
              { type: "fillOtp", code: String(chosen.code), expectedHost: host },
              0,
              binding,
            );
          } catch (e) {
            return sendResponse({
              ok: true,
              filled: false,
              reason: "fill_failed",
              error: String(e?.message ?? e),
              detail,
            });
          }
          sendResponse({
            ok: true,
            filled: !!resp?.filled,
            reason: resp?.reason,
            error: !resp?.filled && resp?.reason === "no_otp_field"
              ? "No verification-code field was found on this page."
              : undefined,
            detail,
          });
          break;
        }

        case "getState":
          // Pure state read; the popup explicitly sends connect when opened.
          sendResponse({ ok: true, state: client.state, hasChallenge: client.hasChallenge });
          break;

        case "connect":
          await ensureConnected({ retryUnavailable: true });
          sendResponse({ ok: client.state === State.NeedsPin || client.ready, state: client.state, hasChallenge: client.hasChallenge });
          break;

        case "requestChallenge":
          // top frame (or popup) only, so a hostile sub-frame cant spam native prompts
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          await ensureConnected();
          // ifNeeded: leave a code thats already up on the Mac alone. re-asking would show a
          // second prompt and kill the code the user is in the middle of typing
          await withTimeout(client.requestChallenge({ ifNeeded: !!msg.ifNeeded }), 8000, "challenge timed out");
          sendResponse({ ok: true, state: client.state, hasChallenge: client.hasChallenge });
          break;

        case "verifyPin": {
          if (fromContent && sender.frameId !== 0) return sendResponse({ ok: false, error: "forbidden" });
          await ensureConnected();
          try {
            // cap so a non-responding helper cant leave the inline PIN box stuck
            await withTimeout(client.verifyPin(msg.pin), 8000, "verification timed out");
          } catch (e) {
            // a spent challenge cant be retried - put a fresh code on the Mac and tell the UI
            // to ask for THAT one, or the user retypes a dead code forever
            let newCode = e?.code === "challenge_reissued";
            if (!newCode && !client.hasChallenge && client.state === State.NeedsPin) {
              try {
                await withTimeout(client.requestChallenge({ ifNeeded: true }), 8000, "challenge timed out");
                newCode = client.hasChallenge;
              } catch (_) {}
            }
            // Another UI can finish unlocking while this stale attempt/recovery
            // was queued. Do not send it back to the PIN screen or replace its code.
            if (client.ready) return sendResponse({ ok: true, state: client.state });
            return sendResponse({
              ok: false,
              error: String(e?.message ?? e),
              newCode,
              state: client.state,
            });
          }
          sendResponse({ ok: true, state: client.state });
          // just unlocked - complete any saves stashed while locked
          if (client.ready) flushPendingSaves();
          break;
        }

        case "getLogins": {
          // real active tab's URL, never caller-supplied
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });
          try {
            const logins = await client.getLoginNamesForURL(tab.id, tab.url);
            sendResponse({ ok: true, logins: uniqueByUsername(describeLoginCandidatesForHost(registrableHost(tab.url), orderForHost(registrableHost(tab.url), logins))) });
          } catch (e) {
            sendResponse({ ok: false, error: `Apple Passwords lookup failed: ${String(e?.message ?? e)}` });
          }
          break;
        }

        case "fillOnPage": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const host = registrableHost(tab.url);
          if (!await isPasswordFillAllowed(tab.url)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          const detailsOnly = msg.mode === 'details';
          const binding = detailsOnly ? { expectedHref: tab.url } : await preparePasswordFill(tab.id, tab.url);
          await ensureConnected();
          if (!client.ready) {
            return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });
          }
          let cred = pwCacheGet(host, msg.loginName?.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(tab.id, binding.expectedHref, msg.loginName);
            if (cred) pwCacheSet(host, cred);
          }
          const detail = cred
            ? {
                username: cred.username || msg.loginName?.username || "",
                password: cred.password || "",
                website: host,
              }
            : undefined;
          await ensurePopupTarget(tab);
          if (detailsOnly) return sendResponse({ ok: !!detail, filled: false, detail, error: !detail ? 'Saved login unavailable' : undefined });
          let filled = false;
          if (cred) {
            // content script re-checks expectedHost before filling
            const resp = await sendToPasswordContent(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              expectedHost: host,
            }, 0, binding);
            filled = !!resp?.filled;
            if (!filled) {
              return sendResponse({
                ok: true,
                filled: false,
                reason: resp?.reason || 'unavailable',
                detail,
              });
            }
            if (filled) {
              recordMru(host, cred.username);
              lastFillByTab.set(tab.id, { host, username: cred.username });
              while (lastFillByTab.size > 64) lastFillByTab.delete(lastFillByTab.keys().next().value);
            }
          }
          sendResponse({
            ok: true,
            filled,
            detail,
            error: !cred ? "The selected saved login could not be opened." : undefined,
          });
          break;
        }

        case "getOtpForLoginDetails": {
          const tab = await activeTab();
          if (!tab?.url || tab.id == null) {
            return sendResponse({ ok: false, error: "no active tab" });
          }
          const host = registrableHost(tab.url);
          if (!await isPasswordFillAllowed(tab.url)) {
            return sendResponse({ ok: false, error: "refusing to read a verification code on a non-HTTPS page" });
          }
          await ensureConnected();
          if (!client.ready) {
            return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });
          }
          const items = await client.getOneTimeCodeForURL(tab.id, tab.url);
          const chosen = selectAccountCode(items, msg.username, host);
          await ensurePopupTarget(tab);
          const fetchedAt = Date.now();
          sendResponse({
            ok: true,
            item: chosen?.code
              ? {
                  username: chosen.username || "",
                  domain: chosen.domain || host || "",
                  code: String(chosen.code),
                  fetchedAt,
                  expiresAt: (Math.floor(fetchedAt / 30_000) + 1) * 30_000,
                }
              : null,
          });
          break;
        }

        case "refreshAndRefill": {
          // drop cache then re-fill the tab's last-filled login with a fresh read, so a
          // password changed in the Passwords app lands without re-clicking Fill
          pwCacheClear();
          const tab = await activeTab();
          const entry = tab?.id != null ? lastFillByTab.get(tab.id) : null;
          const host = tab?.url ? registrableHost(tab.url) : null;
          if (!entry || !host || entry.host !== host) {
            return sendResponse({ ok: true, refilled: false });
          }
          try {
            const binding = await preparePasswordFill(tab.id, tab.url);
            const cred = await client.getPasswordForLoginName(tab.id, binding.expectedHref, { username: entry.username });
            if (!cred) return sendResponse({ ok: true, refilled: false });
            pwCacheSet(host, cred);
            const resp = await sendToPasswordContent(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              expectedHost: host,
            }, 0, binding);
            sendResponse({ ok: true, refilled: !!resp?.filled, username: cred.username, reason: resp?.reason });
          } catch (e) {
            sendResponse({ ok: true, refilled: false, error: String(e?.message ?? e) });
          }
          break;
        }

        case "clearCache":
          // popup refresh: drop cached passwords so the next fill re-reads a just-changed one
          pwCacheClear();
          sendResponse({ ok: true });
          break;

        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      if (msg?.type === 'resolveSave' && sender.tab?.id != null) setSaveStatus(sender.tab.id, 'failed');
      sendResponse({ ...failureResult(e), state: client.state });
    }
  })();
  return true; // async response
});
