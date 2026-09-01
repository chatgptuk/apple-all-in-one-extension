// owns the native connection + SRP session; alarm keep-alive holds the MV3 worker so the PIN isnt re-prompted every idle-out

import { ApplePasswords, State } from "./protocol.js";
import { orderLoginsForHost } from "./login-order.js";

const client = new ApplePasswords();

client.onStateChange((s) => {
  // any state other than unlocked means the session/keys are gone - drop the plaintext cache
  if (s !== State.Unlocked) pwCacheClear();
  broadcast({ type: "state", state: s });
});

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// most-recently-used login per host (in-memory), so the dropdown floats your usual account up
const mruByHost = new Map(); // host -> [username lowercased, most recent first]
function recordMru(host, username) {
  if (!host || !username) return;
  const u = username.toLowerCase();
  const arr = (mruByHost.get(host) || []).filter((x) => x !== u);
  arr.unshift(u);
  mruByHost.set(host, arr.slice(0, 10));
}
function orderForHost(host, logins) {
  return orderLoginsForHost(host, logins, mruByHost.get(host) || []);
}

// which account a submitted password attaches to ("" lets the native sheet ask, null saves nothing); in the background so a redirect cant lose it
function pickSaveTarget({ host, existing, detected, generated, newPwCtx }) {
  const matched = detected && existing.find((u) => u.toLowerCase() === detected.toLowerCase());
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
const pendingSaves = [];
function queuePendingSave(save) {
  const k = `${save.host} ${(save.detected || "").toLowerCase()}`;
  const i = pendingSaves.findIndex((p) => `${p.host} ${(p.detected || "").toLowerCase()}` === k);
  if (i >= 0) pendingSaves.splice(i, 1); // newest wins
  pendingSaves.push(save);
  while (pendingSaves.length > 10) pendingSaves.shift();
}
async function flushPendingSaves() {
  if (!client.ready || !pendingSaves.length) return;
  const batch = pendingSaves.splice(0);
  for (const s of batch) {
    try {
      let existing = [];
      try {
        existing = (await client.getLoginNamesForURL(s.tabId, s.frameUrl))
          .map((l) => l.username)
          .filter(Boolean);
      } catch {}
      const target = pickSaveTarget({ ...s, existing });
      if (target === null) continue;
      await client.saveLogin(s.tabId, s.frameUrl, target, s.password);
    } catch {}
  }
}

// collapse identical-looking usernames: trailing/leading space, zero-width chars, case, and
// unicode composition all equal. keeps internal spaces so distinct usernames arent merged
function normUsername(u) {
  return (u || "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

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

// short-lived cache of decrypted passwords so re-filling the same login skips a second Touch
// ID (apple prompts every read). plaintext in worker memory up to the TTL, cleared on lock
const PW_CACHE_TTL_MS = 30_000; // 30 seconds; plaintext cache remains memory-only
const pwCache = new Map(); // `${host}\n${username lowercased}` -> { cred, at }
function pwCacheKey(host, username) {
  return `${host}\n${(username || "").toLowerCase()}`;
}
function pwCacheGet(host, username) {
  const k = pwCacheKey(host, username);
  const hit = pwCache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > PW_CACHE_TTL_MS) {
    pwCache.delete(k);
    return null;
  }
  return hit.cred;
}
function pwCacheSet(host, cred) {
  if (!host || !cred?.username) return;
  pwCache.set(pwCacheKey(host, cred.username), { cred, at: Date.now() });
}
function pwCacheClear() {
  pwCache.clear();
}

// stuck native call shouldnt leave a UI waiter (inline PIN box) hanging forever
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label || "timed out")), ms)),
  ]);
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
async function sendToPasswordContent(tabId, message, frameId = 0) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (error) {
    if (!isMissingReceiverError(error) || !chrome.scripting?.executeScript) throw error;
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["passwordsContent.bundle.js"],
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  }
}

// defeat the MV3 ~30s idle shutdown that kills the session
const KEEPALIVE_ALARM = "open-passwords-keepalive";
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~24s
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== KEEPALIVE_ALARM) return;
  // touching an extension API resets the idle timer
  chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
});

async function ensureConnected() {
  if (client.state === State.Disconnected) {
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
  return sender.id === chrome.runtime.id && sender.tab === undefined;
}

// resolve from the real active tab, never from caller input
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function registrableHost(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// loopback (secure context) and reserved .test / .localhost TLDs (RFC 6761, never real
// sites) are the only non-HTTPS origins we treat as fillable/saveable
function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host?.endsWith(".localhost") ||
    host?.endsWith(".test")
  );
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
    logins = uniqueByUsername(orderForHost(host, await client.getLoginNamesForURL(tabId, url)));
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
  (async () => {
    try {
      // privileged actions are popup-only; content script gets the inline msgs only
      const fromUi = isFromOwnUi(sender);
      const fromContent = sender.id === chrome.runtime.id && sender.tab !== undefined;
      if (!fromUi && !(fromContent && CONTENT_ALLOWED.has(msg?.type))) {
        sendResponse({ ok: false, error: "forbidden" });
        return;
      }

      switch (msg?.type) {
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
              logins: uniqueByUsername(orderForHost(registrableHost(frameUrl), logins)),
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
          const host = registrableHost(frameUrl);
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });

          const items = await client.getOneTimeCodeForURL(sender.tab.id, frameUrl);
          const requested = normUsername(msg.username || "");
          const chosen =
            items.find((item) => item.code && requested && normUsername(item.username) === requested) ||
            items.find((item) => item.code);
          if (!chosen?.code) return sendResponse({ ok: false, filled: false, error: "No verification code is available for this website." });

          const resp = await sendToPasswordContent(
            sender.tab.id,
            { type: "fillOtp", code: String(chosen.code), expectedHost: host },
            frameId,
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
          const host = registrableHost(frameUrl);
          const isLocalDev =
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "[::1]" ||
            host?.endsWith(".localhost") ||
            host?.endsWith(".test");
          if (!/^https:\/\//i.test(frameUrl) && !isLocalDev) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS frame" });
          }
          // ignore caller-supplied loginName.sites, query by frame's own host
          // (handled in protocol.js); pass only username through
          const safeLogin = { username: msg.loginName?.username };
          // cache hit skips the helper read and its Touch ID; miss reads then caches
          let cred = pwCacheGet(host, safeLogin.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(sender.tab.id, frameUrl, safeLogin);
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
            );
            filled = !!resp?.filled;
            if (!filled && resp?.reason === "no_login_field") {
              return sendResponse({
                ok: true,
                filled: false,
                reason: resp.reason,
                error: "No compatible username or password field was found in this sign-in frame.",
              });
            }
            if (filled) {
              recordMru(host, cred.username);
              lastFillByTab.set(sender.tab.id, { host, username: cred.username });
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
            return sendResponse({ ok: false, error: "refusing to save from a non-HTTPS frame" });
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
            return sendResponse({ ok: true, saved: false, locked: true });
          }

          let existing = [];
          try {
            existing = (await client.getLoginNamesForURL(sender.tab.id, frameUrl))
              .map((l) => l.username)
              .filter(Boolean);
          } catch {}
          const target = pickSaveTarget({ host, existing, detected, generated, newPwCtx });
          console.debug("[Open Passwords] resolveSave", {
            host,
            detected: detected || "(none)",
            generated,
            newPwCtx,
            existingCount: existing.length,
            target: target === null ? "(skip)" : target || "(ask)",
          });
          if (target === null) return sendResponse({ ok: true, saved: false, skipped: true });
          await client.saveLogin(sender.tab.id, frameUrl, target, msg.password);
          sendResponse({ ok: true, saved: true });
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
          if (!/^https:\/\//i.test(tab.url) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          await ensureConnected();
          if (!client.ready) return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });
          const items = await client.getOneTimeCodeForURL(tab.id, tab.url);
          const requested = normUsername(msg.username || "");
          const chosen = requested
            ? items.find((item) => item.code && normUsername(item.username) === requested)
            : items.find((item) => item.code);
          if (!chosen?.code) return sendResponse({ ok: false, filled: false, error: "No verification code is available for this website." });
          const fetchedAt = Date.now();
          const detail = {
            username: chosen.username || msg.username || "",
            domain: chosen.domain || host || "",
            code: String(chosen.code),
            fetchedAt,
            expiresAt: (Math.floor(fetchedAt / 30_000) + 1) * 30_000,
          };
          // Toolbar fill targets the top frame. Cross-origin embedded sign-in frames use the
          // inline chooser, which already knows the exact sender.frameId.
          let resp;
          try {
            resp = await sendToPasswordContent(
              tab.id,
              { type: "fillOtp", code: String(chosen.code), expectedHost: host },
              0,
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
          // Pure state read. Merely opening the toolbar popup must never connect to the native
          // helper or summon a macOS access-code prompt. The user explicitly starts that flow.
          sendResponse({ ok: true, state: client.state, hasChallenge: client.hasChallenge });
          break;

        case "connect":
          await ensureConnected();
          sendResponse({ ok: true, state: client.state });
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
                await withTimeout(client.requestChallenge(), 8000, "challenge timed out");
                newCode = true;
              } catch (_) {}
            }
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
            sendResponse({ ok: true, logins: uniqueByUsername(orderForHost(registrableHost(tab.url), logins)) });
          } catch (e) {
            sendResponse({ ok: false, error: `Apple Passwords lookup failed: ${String(e?.message ?? e)}` });
          }
          break;
        }

        case "fillOnPage": {
          const tab = await activeTab();
          if (!tab?.url) return sendResponse({ ok: false, error: "no active tab" });
          const host = registrableHost(tab.url);
          // require HTTPS except local dev: loopback (secure context) and reserved
          // .test / .localhost TLDs (RFC 6761, never real sites)
          const isLocalDev =
            host === "localhost" ||
            host === "127.0.0.1" ||
            host === "[::1]" ||
            host?.endsWith(".localhost") ||
            host?.endsWith(".test");
          if (!/^https:\/\//i.test(tab.url) && !isLocalDev) {
            return sendResponse({ ok: false, error: "refusing to fill on a non-HTTPS page" });
          }
          await ensureConnected();
          if (!client.ready) {
            return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });
          }
          let cred = pwCacheGet(host, msg.loginName?.username);
          if (!cred) {
            cred = await client.getPasswordForLoginName(tab.id, tab.url, msg.loginName);
            if (cred) pwCacheSet(host, cred);
          }
          const detail = cred
            ? {
                username: cred.username || msg.loginName?.username || "",
                password: cred.password || "",
                website: host,
              }
            : undefined;
          let filled = false;
          if (cred) {
            // content script re-checks expectedHost before filling
            const resp = await sendToPasswordContent(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              expectedHost: host,
            }, 0);
            filled = !!resp?.filled;
            if (!filled && resp?.reason === "no_login_field") {
              return sendResponse({
                ok: true,
                filled: false,
                reason: resp.reason,
                error: "No compatible username or password field was found on this page.",
                detail,
              });
            }
            if (filled) {
              recordMru(host, cred.username);
              lastFillByTab.set(tab.id, { host, username: cred.username });
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
          if (!/^https:\/\//i.test(tab.url) && !isLocalDevHost(host)) {
            return sendResponse({ ok: false, error: "refusing to read a verification code on a non-HTTPS page" });
          }
          await ensureConnected();
          if (!client.ready) {
            return sendResponse({ ok: false, locked: true, error: "Apple Passwords is locked" });
          }
          const items = await client.getOneTimeCodeForURL(tab.id, tab.url);
          const requested = normUsername(msg.username || "");
          const chosen = requested
            ? items.find((item) => item.code && normUsername(item.username) === requested)
            : items.find((item) => item.code);
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
            const cred = await client.getPasswordForLoginName(tab.id, tab.url, { username: entry.username });
            if (!cred) return sendResponse({ ok: true, refilled: false });
            pwCacheSet(host, cred);
            const resp = await sendToPasswordContent(tab.id, {
              type: "fill",
              username: cred.username,
              password: cred.password,
              expectedHost: host,
            }, 0);
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
      sendResponse({ ok: false, error: String(e?.message ?? e), state: client.state });
    }
  })();
  return true; // async response
});
