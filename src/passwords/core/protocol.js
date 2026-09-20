// client for the macOS PasswordManagerBrowserExtensionHelper over
// chrome.runtime.connectNative("com.apple.passwordmanager").
// flow: GET_CAPABILITIES -> handshake m0 (challenge / PIN prompt) -> user enters
// PIN -> handshake m2 (verify) -> encrypted queries.
// ported from au2001/icloud-passwords-firefox (Apache-2.0). see NOTICE

import { SRPSession, SecretSessionVersion, MSGType } from "./srp.js";
import { accountKey } from './account-identity.js';
import { selectUniqueSecretForHost } from './login-order.js';
import {
  bytesToBase64,
  base64ToBytes,
  bytesToUtf8,
  bigIntToBytes,
  bytesToBigInt,
  constantTimeEqual,
  QueryStatus,
  queryStatusError,
} from "./crypto.js";

const NATIVE_HOST = "com.apple.passwordmanager";
const BROWSER_NAME = "Chrome";
const VERSION = "1.0";
const EMPTY_LOOKUP_RETRY_MS = 120;
const LOOKUP_QUEUE_TIMEOUT_MS = 2500;
const INTERACTIVE_SECRET_TIMEOUT_MS = 60_000;
// Metadata can be slow after wake or while Apple's UI is busy. Stop the caller's
// spinner after 5s, but allow 25s to drain that exact reply before ending SRP.
const METADATA_DRAIN_MS = 25_000;
const NATIVE_EVENT_REASONS = new Set(['connected', 'unlocked', 'challenge_requested', 'verification_failed', 'metadata_slow', 'metadata_drained', 'response_timeout', 'helper_exited', 'host_unavailable', 'transport_error', 'connection_closed', 'passwords_disabled', 'relogin_required', 'session_expired', 'incompatible_helper']);
// how long we still trust a code the Mac put on screen. past this we re-prompt rather than
// verify against a challenge the user has probably lost track of
const CHALLENGE_TTL_MS = 3 * 60_000;

// the typed code was for a challenge that no longer exists. callers show "new code" wording
// instead of "incorrect", because retyping the old code can never work
function challengeError(message) {
  const e = new Error(message);
  e.code = "challenge_reissued";
  return e;
}

export const Command = {
  END: 0,
  HANDSHAKE: 2,
  GET_LOGIN_NAMES_FOR_URL: 4,
  GET_PASSWORD_FOR_LOGIN_NAME: 5,
  SET_PASSWORD_FOR_LOGIN_NAME_URL: 6, // save or update a login
  TAB_EVENT: 8,
  PASSWORDS_DISABLED: 9,
  RELOGIN_NEEDED: 10,
  GET_CAPABILITIES: 14,
  ONE_TIME_CODE_AVAILABLE: 15,
  GET_ONE_TIME_CODES: 16,
  DID_FILL_ONE_TIME_CODE: 17,
};

const Action = { UPDATE: 1, SEARCH: 2, ADD_NEW: 3, MAYBE_ADD: 4, GHOST_SEARCH: 5 };

export const State = {
  Disconnected: "disconnected",
  NeedsPin: "needs_pin", // challenge issued, waiting for the user's PIN
  Unlocked: "unlocked", // session key established
  NoHelper: "no_helper", // native host missing, forbidden, or incompatible
};

export function safeNativeEvent(event) {
  if (!event || !NATIVE_EVENT_REASONS.has(event.reason) || !Number.isFinite(event.at) || event.at < 0) return undefined;
  return { reason: event.reason, at: event.at,
    ...(Object.values(Command).includes(event.command) ? { command: event.command } : {}) };
}

function nativeConnectionFailureState(error) {
  const message = String(error?.message ?? error ?? '');
  // Chrome also mentions "host" for transient failures, e.g. "Native host has
  // exited." Only installation/registration/permission errors imply NoHelper.
  return /specified native messaging host not found|native messaging host .+ is not registered|access to the specified native messaging host is forbidden|invalid native messaging host name specified/i.test(message)
    ? State.NoHelper
    : State.Disconnected;
}

function jsonToBase64(obj) {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(obj)));
}

function queryEntries(response) {
  const entries = response?.Entries ?? response?.entries;
  return Array.isArray(entries) ? entries : [];
}

function entryUsername(entry) {
  return entry?.USR ?? entry?.username ?? entry?.user ?? "";
}

function entryPassword(entry) {
  return entry?.PWD ?? entry?.password;
}

export class ApplePasswords {
  constructor({ onDiagnosticEvent = (_event) => {} } = {}) {
    this.port = undefined;
    this.session = undefined;
    this.capabilities = undefined;
    this.state = State.Disconnected;
    this._waiters = new Map(); // cmd -> {resolve, reject, timer}
    this._onState = () => {};
    this._challengeAt = 0; // when the current code went up on the Mac
    this._challengeGen = 0; // bumped per challenge, so a queued verify can spot a stale one
    this._challengePending = undefined; // in-flight requestChallenge, shared by callers
    this._connecting = undefined;
    this._startedAt = Date.now();
    this._diagnosticEvents = [];
    this._onDiagnosticEvent = onDiagnosticEvent;
    // native protocol echoes the same cmd on replies with no correlation id, so two
    // in-flight requests with the same cmd collide. serialize all exchanges here
    this._lock = Promise.resolve();
  }

  _withLock(fn, { queueTimeoutMs = null } = {}) {
    let expired = false;
    let timer = null;
    const queueTimeout =
      queueTimeoutMs == null
        ? null
        : new Promise((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new Error("Apple Passwords is busy; retry the lookup"));
            }, queueTimeoutMs);
          });
    const invoke = () => {
      if (timer) clearTimeout(timer);
      // A metadata lookup that already timed out in the queue is stale. Skip it
      // when the preceding Touch ID/password read eventually releases the lock.
      if (expired) return undefined;
      return fn();
    };
    const run = this._lock.then(invoke, invoke);
    // keep chain alive even if fn rejects, so the next caller still runs
    this._lock = run.then(
      () => {},
      () => {},
    );
    return queueTimeout ? Promise.race([run, queueTimeout]) : run;
  }

  onStateChange(fn) {
    this._onState = fn;
  }

  _recordNativeEvent(reason, command) {
    // Strict allowlists: never keep native messages, URLs, account names or data.
    const event = safeNativeEvent({ reason, at: Date.now(), command });
    if (!event) return;
    this._diagnosticEvents.push(event);
    if (this._diagnosticEvents.length > 20) this._diagnosticEvents.shift();
    try { this._onDiagnosticEvent({ ...event }); } catch (_) {}
  }

  getDiagnostics() {
    return { startedAt: this._startedAt, events: this._diagnosticEvents.map((event) => ({ ...event })) };
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (s === State.Unlocked) this._recordNativeEvent('unlocked');
    try {
      this._onState(s);
    } catch (_) {}
  }

  get ready() {
    return (
      this.port !== undefined &&
      this.session !== undefined &&
      this.session.sharedKey !== undefined &&
      this.state === State.Unlocked
    );
  }

  _assertCanSend(cmd) {
    if (!this.port) throw new Error("connection closed");
    // replies carry no correlation id, so a second request on the same cmd would steal the
    // first one's reply. refuse instead of overwriting the waiter
    // A timed-out metadata reply must be consumed before ANY new request is sent.
    // In particular, a retry with the same cmd must never receive the old reply.
    if (this._waiters.has(cmd) || [...this._waiters.values()].some((w) => w.draining))
      throw new Error("Apple Passwords is busy; retry the lookup");
  }

  _send(cmd, body = {}, timeoutMs = 5000) {
    try { this._assertCanSend(cmd); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, draining: false };
      entry.timer =
        timeoutMs == null
          ? null
          : setTimeout(() => {
              if (this._waiters.get(cmd) === entry) {
                const error = new Error("timeout waiting for response");
                if (cmd === Command.GET_LOGIN_NAMES_FOR_URL || cmd === Command.GET_ONE_TIME_CODES) {
                  entry.draining = true;
                  this._recordNativeEvent('metadata_slow', cmd);
                  entry.timer = setTimeout(() => {
                    if (this._waiters.get(cmd) === entry)
                      this._retireConnection(error, State.Disconnected, 'response_timeout', cmd);
                  }, METADATA_DRAIN_MS);
                  reject(error);
                } else {
                  // Secret reads and handshakes still fail closed immediately.
                  this._retireConnection(error, State.Disconnected, 'response_timeout', cmd);
                }
              }
            }, timeoutMs);
      this._waiters.set(cmd, entry);
      try {
        this.port.postMessage({ cmd, ...body });
      } catch (e) {
        this._retireConnection(e, State.Disconnected, 'transport_error', cmd);
      }
    });
  }

  _rejectWaiters(error) {
    for (const waiter of this._waiters.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this._waiters.clear();
  }

  _retireConnection(error = new Error('connection closed'), state = State.Disconnected, reason = 'connection_closed', command) {
    this._recordNativeEvent(reason, command);
    const port = this.port;
    this.port = undefined;
    this.session = undefined;
    this.capabilities = undefined;
    this._challengeAt = 0;
    this._challengeGen++;
    this._rejectWaiters(error);
    this._setState(state);
    try { port?.disconnect(); } catch (_) {}
  }

  _dispatch(message, sourcePort = this.port) {
    if (!this.port || sourcePort !== this.port) return;
    if (message.cmd === Command.PASSWORDS_DISABLED || message.cmd === Command.RELOGIN_NEEDED) {
      this._retireConnection(new Error('Apple Passwords session expired'), State.Disconnected,
        message.cmd === Command.PASSWORDS_DISABLED ? 'passwords_disabled' : 'relogin_required', message.cmd);
      return;
    }
    const w = this._waiters.get(message.cmd);
    if (w) {
      this._waiters.delete(message.cmd);
      if (w.timer) clearTimeout(w.timer);
      if (w.draining) {
        this._recordNativeEvent('metadata_drained', message.cmd);
        return; // discard late payload; never deliver it to an abandoned caller
      }
      w.resolve(message);
    }
  }

  // does NOT reset an existing unlocked session (core fix vs Apple's extension,
  // which re-pairs on every connect)
  async connect() {
    if (this._connecting) return this._connecting;
    if (this.port) return;
    const connecting = new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connectNative(NATIVE_HOST);
      } catch (e) {
        const state = nativeConnectionFailureState(e);
        this._retireConnection(e, state, state === State.NoHelper ? 'host_unavailable' : 'transport_error');
        return reject(e);
      }
      this.port = port;

      port.onMessage.addListener((msg) => this._dispatch(msg, port));
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message;
        if (this.port !== port) return;
        const state = nativeConnectionFailureState(err);
        this._retireConnection(new Error(err || 'connection closed'), state,
          state === State.NoHelper ? 'host_unavailable' : /native host has exited/i.test(err || '') ? 'helper_exited' : 'transport_error');
      });

      this._send(Command.GET_CAPABILITIES)
        .then((reply) => {
          if (this.port !== port) throw new Error('connection replaced');
          this.capabilities = reply.capabilities ?? {};
          // capabilities flag may be absent or default to "old"; real helper
          // negotiates per-handshake via PROTO (we send + verify RFC there). only
          // reject if capabilities explicitly demand a non-RFC version
          if (
            this.capabilities.secretSessionVersion !== undefined &&
            this.capabilities.secretSessionVersion !== SecretSessionVersion.SRPWithRFCVerification
          ) {
            const error = new Error("unsupported capabilities (expected SRP RFC verification)");
            this._retireConnection(error, State.NoHelper, 'incompatible_helper');
            return reject(error);
          }
          this.session = new SRPSession(this.capabilities.shouldUseBase64);
          this._setState(State.NeedsPin);
          this._recordNativeEvent('connected');
          resolve();
        })
        .catch((error) => {
          // A failed initialization must not leave a zombie port that makes the
          // next connect() return early. Never retire a newer replacement port.
          if (this.port === port) this._retireConnection(error);
          reject(error);
        });
    });
    this._connecting = connecting;
    try { return await connecting; }
    finally { if (this._connecting === connecting) this._connecting = undefined; }
  }

  // is there a challenge the user can still answer? the code on the Mac only belongs to
  // the newest challenge, so anything else must be re-issued before we verify
  get hasChallenge() {
    return (
      this.state === State.NeedsPin &&
      this.session !== undefined &&
      this.session.serverPublicKey !== undefined &&
      this.session.salt !== undefined &&
      Date.now() - this._challengeAt < CHALLENGE_TTL_MS
    );
  }

  // ask the helper for a challenge. macOS shows the 6-digit PIN access prompt.
  // ifNeeded keeps a live prompt alive instead of putting a second code on screen and
  // silently invalidating the one the user is reading
  requestChallenge({ ifNeeded = false } = {}) {
    if (!this.session) return Promise.reject(new Error("not connected"));
    // An old inline picker can outlive a successful toolbar unlock. Even its
    // explicit "new code" button must not re-pair an already authenticated session.
    if (this.ready || (ifNeeded && this.hasChallenge)) return Promise.resolve(false);
    // collapse concurrent requests: two prompts would race and only the last code works
    if (this._challengePending) return this._challengePending;
    const session = this.session;
    const p = this._withLock(() => {
      if (this.session !== session) throw new Error('session changed');
      // Another UI may have finished unlocking while this request was queued.
      if (this.ready || (ifNeeded && this.hasChallenge)) return false;
      return this._issueChallenge();
    }, { queueTimeoutMs: LOOKUP_QUEUE_TIMEOUT_MS });
    this._challengePending = p;
    const clear = () => {
      if (this._challengePending === p) this._challengePending = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  async _issueChallenge() {
    // A pending late metadata reply must not let a failed handshake reset keys.
    this._assertCanSend(Command.HANDSHAKE);
    const session = this.session;
    // reset prior handshake state
    session.serverPublicKey = undefined;
    session.salt = undefined;
    session.sharedKey = undefined;
    this._challengeAt = 0;
    const gen = ++this._challengeGen;
    this._recordNativeEvent('challenge_requested', Command.HANDSHAKE);

    const reply = await this._send(Command.HANDSHAKE, {
      msg: {
        QID: "m0",
        PAKE: jsonToBase64({
          TID: session.username,
          MSG: MSGType.ClientKeyExchange,
          A: session.serialize(session.clientPublicKeyBytes),
          VER: VERSION,
          PROTO: [SecretSessionVersion.SRPWithRFCVerification],
        }),
        HSTBRSR: BROWSER_NAME,
      },
    });

    if (this.session !== session || this._challengeGen !== gen) throw new Error('session changed');
    const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
    if (pake.TID !== session.username) throw new Error("challenge for another session");
    if (pake.ErrCode !== undefined) throw new Error(`server hello error ${pake.ErrCode}`);
    if (pake.MSG.toString() !== MSGType.ServerKeyExchange.toString()) throw new Error("unexpected server message");
    if (pake.PROTO !== SecretSessionVersion.SRPWithRFCVerification) throw new Error("unsupported protocol");

    const B = bytesToBigInt(session.deserialize(pake.B));
    const s = session.deserialize(pake.s); // raw bytes, see setServerPublicKey
    session.setServerPublicKey(B, s);
    this._challengeAt = Date.now();
    this._setState(State.NeedsPin);
    return true;
  }

  // a PIN is only valid for the challenge it was displayed for. verifying it against any
  // other challenge always fails, so never quietly swap the challenge underneath the user -
  // issue a fresh one and tell the caller to ask for the NEW code
  async verifyPin(pin) {
    if (this.ready) return;
    if (!this.session) throw new Error("not connected");
    if (!this.hasChallenge) {
      await this.requestChallenge({ ifNeeded: true });
      if (this.ready) return;
      throw challengeError("Enter the new code your Mac is showing now");
    }
    const session = this.session;
    const gen = this._challengeGen;
    return this._withLock(async () => {
      if (this.session !== session) throw new Error('session changed');
      // A duplicate submission may have waited behind the successful one.
      if (this.ready) return;
      // something re-issued while we queued: the typed code is for the old prompt
      if (gen !== this._challengeGen) throw challengeError("Enter the new code your Mac is showing now");
      const assertCurrent = () => {
        if (this.session !== session || gen !== this._challengeGen) throw new Error('session changed');
      };
      this._assertCanSend(Command.HANDSHAKE);
      try {
        await session.setSharedKey(pin);
        assertCurrent();
        const m = await session.computeM();
        assertCurrent();

        const reply = await this._send(Command.HANDSHAKE, {
          msg: {
            QID: "m2",
            PAKE: jsonToBase64({
              TID: session.username,
              MSG: MSGType.ClientVerification,
              M: session.serialize(m, false),
            }),
          },
        });

        assertCurrent();
        const pake = JSON.parse(bytesToUtf8(base64ToBytes(reply.payload.PAKE)));
        if (pake.TID !== session.username) throw new Error("verification for another session");
        if (pake.MSG.toString() !== MSGType.ServerVerification.toString()) throw new Error("unexpected server message");
        if (pake.ErrCode === 1) throw new Error("Incorrect code");
        if (pake.ErrCode !== 0 && pake.ErrCode !== undefined) throw new Error(`verification error ${pake.ErrCode}`);

        const hamk = await session.computeHMAC(m);
        assertCurrent();
        if (!constantTimeEqual(session.deserialize(pake.HAMK), hamk))
          throw new Error("server HAMK mismatch");

        this._setState(State.Unlocked);
      } catch (e) {
        // the helper burns the challenge on a failed verify, so this code is dead now.
        // drop it - hasChallenge goes false and the next attempt gets a fresh prompt.
        // the session itself can be gone already if the port dropped mid-verify
        if (this.session === session && gen === this._challengeGen) {
          session.sharedKey = undefined;
          session.serverPublicKey = undefined;
          session.salt = undefined;
          this._challengeAt = 0;
          this._challengeGen++;
          this._recordNativeEvent('verification_failed', Command.HANDSHAKE);
        }
        throw e;
      }
    }, { queueTimeoutMs: LOOKUP_QUEUE_TIMEOUT_MS });
  }

  async _encryptedQuery(cmd, tabId, wireUrl, payloadBody, timeoutMs, options = {}) {
    const session = this.session;
    if (!session?.sharedKey) throw new Error('not unlocked');
    const sdata = session.serialize(await session.encrypt(payloadBody));
    if (this.session !== session) throw new Error('session changed');
    const qid =
      options.qid ??
      (cmd === Command.GET_LOGIN_NAMES_FOR_URL ? "CmdGetLoginNames4URL" : "CmdGetPassword4LoginName");
    const body = {
      tabId,
      frameId: options.frameId ?? 0,
      payload: {
        QID: qid,
        SMSG: JSON.stringify({ TID: this.session.username, SDATA: sdata }),
      },
    };
    if (options.includeUrl !== false) body.url = wireUrl;

    const reply = await this._send(cmd, body, timeoutMs);
    let payload = reply.payload;
    if (typeof payload === "string") payload = JSON.parse(payload);
    let smsg = payload?.SMSG;
    if (typeof smsg === "string") smsg = JSON.parse(smsg);
    if (this.session !== session || !smsg || smsg.TID !== session.username) throw new Error("response for another session");
    const data = await session.decrypt(session.deserialize(smsg.SDATA));
    if (this.session !== session) throw new Error('session changed');
    const result = JSON.parse(bytesToUtf8(data));
    if (result.STATUS === QueryStatus.InvalidSession) {
      const error = new Error('Apple Passwords session expired');
      this._retireConnection(error, State.Disconnected, 'session_expired', cmd);
      throw error;
    }
    return result;
  }

  async getLoginNamesForURL(tabId, url) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await this._encryptedQuery(
          Command.GET_LOGIN_NAMES_FOR_URL,
          tabId,
          hostname,
          { ACT: Action.GHOST_SEARCH, URL: hostname },
          5000,
        );
        if (res.STATUS === QueryStatus.Success) {
          const entries = queryEntries(res);
          if (entries.length || attempt === 1) {
            return entries.map((e) => ({
              username: entryUsername(e),
              sites: e.sites ?? e.SITES,
              highLevelDomain: e.highLevelDomain ?? e.HIGH_LEVEL_DOMAIN,
            }));
          }
        } else if (res.STATUS !== QueryStatus.NoResults) {
          throw queryStatusError(res.STATUS);
        } else if (attempt === 1) {
          return [];
        }
        await new Promise((resolve) => setTimeout(resolve, EMPTY_LOOKUP_RETRY_MS));
      }
      return [];
    }, { queueTimeoutMs: LOOKUP_QUEUE_TIMEOUT_MS });
  }

  async getPasswordForLoginName(tabId, url, loginName) {
    if (!this.ready) throw new Error("not unlocked");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      const res = await this._encryptedQuery(
        Command.GET_PASSWORD_FOR_LOGIN_NAME,
        tabId,
        // query by trusted frame hostname, never caller-supplied loginName.sites
        // which a page could use to request another origin's password
        hostname,
        { ACT: Action.SEARCH, URL: hostname, USR: loginName.username },
        INTERACTIVE_SECRET_TIMEOUT_MS, // allow Touch ID, but never block later lookups forever
      );
      if (res.STATUS === QueryStatus.Success) {
        const entries = queryEntries(res)
          .filter((entry) => accountKey(entryUsername(entry)) === accountKey(loginName.username))
          .map((entry) => ({
            username: entryUsername(entry),
            password: entryPassword(entry),
            sites: entry.sites ?? entry.SITES,
            highLevelDomain: entry.highLevelDomain ?? entry.HIGH_LEVEL_DOMAIN,
          }));
        const e = selectUniqueSecretForHost(hostname, entries, (entry) => typeof entry.password === 'string' ? entry.password : undefined);
        if (!e) return undefined;
        // apple's reply is USR/PWD/customTitle/highLevelDomain/sites - no note or OTP seed (verified), cant surface those
        return {
          username: e.username,
          password: e.password,
          sites: e.sites,
        };
      }
      if (res.STATUS === QueryStatus.NoResults) return undefined;
      throw queryStatusError(res.STATUS);
    // Do not open a delayed Touch ID prompt after the UI has already abandoned a
    // request queued behind another authorization. An active read still gets 60s.
    }, { queueTimeoutMs: LOOKUP_QUEUE_TIMEOUT_MS });
  }

  // Apple Passwords keeps website verification codes behind separate helper commands.
  // Metadata uses cmd 16 + GHOST_SEARCH; the current TOTP value uses cmd 17 + SEARCH.
  // The helper keys these requests by the *absolute frame URL* in frameURLs and does not
  // want the normal top-level url field used by password lookups.
  async _oneTimeCodeQuery(tabId, url, revealCode) {
    if (!this.ready) throw new Error("not unlocked");
    const frameUrl = new URL(url).href;
    const cmd = revealCode ? Command.DID_FILL_ONE_TIME_CODE : Command.GET_ONE_TIME_CODES;
    return this._withLock(async () => {
      const res = await this._encryptedQuery(
        cmd,
        tabId,
        frameUrl,
        {
          ACT: revealCode ? Action.SEARCH : Action.GHOST_SEARCH,
          TYPE: "oneTimeCodes",
          frameURLs: [frameUrl],
        },
        revealCode ? INTERACTIVE_SECRET_TIMEOUT_MS : 5000,
        { qid: "CmdDidFillOneTimeCode", includeUrl: false },
      );
      if (res.STATUS === QueryStatus.Success) {
        return (res.Entries ?? []).map((e) => ({
          username: e.username ?? e.USR ?? e.user ?? "",
          domain: e.domain ?? e.URL ?? e.url ?? e.site ?? "",
          source: e.source ?? "",
          code: e.code ?? e.OTP ?? e.otp,
        }));
      }
      if (res.STATUS === QueryStatus.NoResults) return [];
      throw queryStatusError(res.STATUS);
    }, { queueTimeoutMs: LOOKUP_QUEUE_TIMEOUT_MS });
  }

  async listOneTimeCodesForURL(tabId, url) {
    return this._oneTimeCodeQuery(tabId, url, false);
  }

  async getOneTimeCodeForURL(tabId, url) {
    return this._oneTimeCodeQuery(tabId, url, true);
  }

  // save or update a login in Apple Passwords. cmd 6 with ACT maybeAdd lets the helper
  // decide add-vs-update and drive the native macOS save prompt (with Touch ID). the
  // helper's cmd-6 reply carries no decryptable body so we dont parse one - a page can
  // only ever trigger the OS prompt, never write to the vault silently
  async saveLogin(tabId, url, username, password) {
    if (!this.ready) throw new Error("not unlocked");
    if (!password) throw new Error("no password to save");
    const { hostname } = new URL(url);
    return this._withLock(async () => {
      this._assertCanSend(Command.SET_PASSWORD_FOR_LOGIN_NAME_URL);
      const sdata = this.session.serialize(
        await this.session.encrypt({
          ACT: Action.MAYBE_ADD,
          URL: "",
          USR: "",
          PWD: "",
          NURL: hostname,
          NUSR: username ?? "",
          NPWD: password,
        }),
      );
      const body = {
        tabId,
        frameId: 0,
        payload: {
          QID: "CmdNewAccount4URL",
          SMSG: JSON.stringify({ TID: this.session.username, SDATA: sdata }),
        },
      };
      // Save is fire-and-forget: some helper versions never acknowledge it.
      // Do not install a waiter or apply the reply-required timeout policy here.
      // Any later cmd-6 acknowledgment is unsolicited and cannot steal a reply.
      if (!this.ready) throw new Error('not unlocked');
      this._assertCanSend(Command.SET_PASSWORD_FOR_LOGIN_NAME_URL);
      this.port.postMessage({ cmd: Command.SET_PASSWORD_FOR_LOGIN_NAME_URL, ...body });
      return true;
    });
  }

  disconnect() {
    try {
      this.port?.postMessage({ cmd: Command.END });
    } catch (_) {}
    this._retireConnection();
  }
}
