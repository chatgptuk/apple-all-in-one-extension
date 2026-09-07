import assert from 'node:assert/strict';
import test from 'node:test';
import { functionsFrom, deferred } from './source-harness.mjs';
import { failureReason, failureMessage } from '../src/passwords/message-contracts.js';
import { sitePreferencesFor } from '../src/passwords/site-preferences.js';

const source = 'src/passwords/content.js';
function timeSource() {
  let at = 0, sequence = 0;
  const timers = new Map();
  return {
    Date: { now: () => at },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: at + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) { at += ms; for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.fn(); } },
    timers,
  };
}
const secrets = () => ({ lastAutofill: null, lastGenerated: null, pendingFill: null, lastSaveKey: '', lastSaveTarget: null, lastSaveAt: 0, secretCleanupTimer: null, saveNoticeTimer: null, saveNotice: null, fillAnchor: null });

test('content actively clears each secret at its bounded lifetime without another action', () => {
  const time = timeSource();
  const context = functionsFrom(source, ['scheduleSecretCleanup'], { ...secrets(), ...time });
  context.lastAutofill = { password: 'ci-autofill', at: 0 };
  context.lastGenerated = { password: 'ci-generated', at: 0 };
  context.pendingFill = { value: 'ci-anchor-value', at: 0 };
  context.lastSaveKey = 'metadata-only'; context.lastSaveTarget = {}; context.lastSaveAt = 0;
  context.scheduleSecretCleanup();
  assert.equal(time.timers.size, 1);
  time.advance(15_000);
  assert.equal(context.lastSaveKey, '');
  assert.equal(context.lastSaveTarget, null);
  time.advance(75_000);
  assert.equal(context.pendingFill, null);
  assert.ok(context.lastAutofill);
  time.advance(210_000);
  assert.equal(context.lastAutofill, null);
  assert.ok(context.lastGenerated);
  time.advance(300_000);
  assert.equal(context.lastGenerated, null);
  assert.equal(time.timers.size, 0);
});

test('invalidated documents release all secret references, timers and status UI', () => {
  const time = timeSource();
  let closed = 0, removed = 0;
  const context = functionsFrom(source, ['scheduleSecretCleanup', 'clearPageSecrets', 'stopInvalidatedContentScript'], {
    ...secrets(), ...time, extensionContextInvalidated: false, offerSeq: 0, aliasLookupSeq: 0,
    closeUi: () => closed++, saveNotice: { remove() { removed++; } },
  });
  context.lastAutofill = { password: 'ci-password', at: 0 };
  context.lastGenerated = { password: 'ci-generated', at: 0 };
  context.fillAnchor = {};
  context.scheduleSecretCleanup();
  context.stopInvalidatedContentScript();
  assert.equal(context.lastAutofill, null);
  assert.equal(context.lastGenerated, null);
  assert.equal(context.fillAnchor, null);
  assert.equal(time.timers.size, 0);
  assert.equal(removed, 1);
  assert.equal(closed, 1);
  context.stopInvalidatedContentScript();
  assert.equal(closed, 1);
});

test('site preference changes affect only the exact hostname and retire open suggestions', () => {
  let closed = 0;
  const context = functionsFrom(source, ['applySitePreferences'], {
    sitePreferencesFor, location: { hostname: 'signin.example.test' },
    sitePreferences: { suggestions: 'automatic', privateSignup: true },
    offerSeq: 0, aliasLookupSeq: 0, closeUi: () => closed++,
  });
  context.applySitePreferences({ 'example.test': { suggestions: 'manual', privateSignup: false } });
  assert.equal(closed, 0);
  context.applySitePreferences({ 'signin.example.test': { suggestions: 'manual', privateSignup: false } });
  assert.equal(closed, 1);
  assert.equal(context.sitePreferences.suggestions, 'manual');
  assert.equal(context.offerSeq, 1);
  assert.equal(context.aliasLookupSeq, 1);
});

function chooserContext({ privateSignup = true, suggestions = 'automatic', ready = Promise.resolve(), logins = [] } = {}) {
  class Input {}
  const field = new Input();
  const messages = [], states = [];
  const context = functionsFrom(source, ['openForField', 'loginMetadata'], {
    sitePreferences: { suggestions, privateSignup }, sitePreferencesReady: ready,
    extensionContextInvalidated: false, pageInactive: false, HTMLInputElement: Input, offerSeq: 0, aliasLookupSeq: 0,
    location: { hostname: 'signin.example.test' }, window: { top: {} },
    frameIsSafe: () => true, isOtpField: () => false, isHideEmailField: () => true,
    isSignupContext: () => true, isLoginField: () => true, isNewPasswordField: () => true,
    sendRuntimeMessage: async (message) => { messages.push(message); return message.type === 'inlineLogins' ? { ok: true, logins } : { ok: true, ready: true }; },
    deepActiveElement: () => field, appleSignInControl: () => null,
    preparedPasswordForThisSite: () => '', passwordRequirementsFor: () => ({}),
    buildSecureUi: (_field, state) => states.push(state), refreshExistingHme: async () => {}, L: (en) => en,
  });
  return { context, field, messages, states };
}

test('automatic suggestions wait for initial storage preferences before any lookup', async () => {
  const ready = deferred();
  const { context, field, messages, states } = chooserContext({ ready: ready.promise });
  const opening = context.openForField(field);
  assert.equal(messages.length, 0);
  context.sitePreferences = { suggestions: 'manual', privateSignup: false };
  ready.resolve(); await opening;
  assert.equal(messages.length, 0);
  assert.equal(states.length, 0);
});

test('disabling private signup keeps password generation but makes no alias request', async () => {
  const { context, field, messages, states } = chooserContext({ privateSignup: false });
  await context.openForField(field);
  assert.deepEqual(messages.map((message) => message.type), ['inlineLogins']);
  assert.equal(states[0].canGenerate, true);
  assert.equal(states[0].canSmartSignup, false);
});

test('saved-login source, match and ambiguity metadata reach the isolated chooser', async () => {
  const { context, field, states } = chooserContext({ privateSignup: false, logins: [{ username: 'ci-user', sourceWebsite: 'signin.example.test', match: 'exact', ambiguous: true, password: 'must-not-leak' }] });
  await context.openForField(field);
  assert.equal(states[0].logins[0].sourceWebsite, 'signin.example.test');
  assert.equal(states[0].logins[0].match, 'exact');
  assert.equal(states[0].logins[0].ambiguous, true);
  assert.equal('password' in states[0].logins[0], false);
});

test('all matching aliases reach the chooser and disabling signup cancels late metadata', async () => {
  const request = deferred();
  const anchor = {}, updates = [];
  const candidates = [{ hme: 'ci-one@icloud.com' }, { hme: 'ci-two@icloud.com' }];
  const context = functionsFrom(source, ['refreshExistingHme'], {
    sitePreferencesReady: Promise.resolve(), sitePreferences: { suggestions: 'automatic', privateSignup: true },
    extensionContextInvalidated: false, pageInactive: false,
    uiAnchor: anchor, uiState: { logins: [] }, aliasLookupSeq: 1,
    isOtpField: () => false, isHideEmailField: () => true, isSignupContext: () => true,
    sendRuntimeMessage: () => request.promise, postUi: (state) => updates.push(state),
  });
  const refresh = context.refreshExistingHme(anchor, 1);
  request.resolve({ ready: true, existingHme: candidates[0], existingHmes: candidates });
  await refresh;
  assert.equal(updates[0].existingHmes.length, 2);
  context.sitePreferences.privateSignup = false;
  await context.refreshExistingHme(anchor, 1);
  assert.equal(updates.length, 1);
});

test('inline failure copy is localized and never echoes native secret/error payloads', () => {
  const context = functionsFrom(source, ['safeFailureMessage'], { failureReason, failureMessage, appResolvedLanguage: () => 'zh-CN' });
  assert.match(context.safeFailureMessage({ reason: 'target_changed' }), /输入框/);
  const copy = context.safeFailureMessage({ error: 'Native secret=ci-secret https://private.invalid/account' });
  assert.doesNotMatch(copy, /ci-secret|private\.invalid/);
});

for (const response of [{ ok: true, status: 'waiting_unlock' }, { ok: true, status: 'submitted' }, { ok: false, status: 'failed' }, { ok: true, status: 'failed' }, { ok: true, status: 'expired' }]) {
  test(`save feedback awaits ${response.status} and never uses the password as a dedup key`, async () => {
    const request = deferred();
    const field = { getAttribute: () => 'new-password' };
    const scope = { querySelectorAll: () => [field] };
    const notices = [], calls = [];
    const context = functionsFrom(source, ['maybeOfferSave', 'saveStatusMessage'], {
      ...secrets(), frameIsSafe: () => true,
      collectSubmittedCredentials: () => ({ username: '', password: 'ci-sensitive-value', allPasswords: ['ci-sensitive-value'] }),
      location: { hostname: 'example.test' }, anchorPwField: () => field, isPasswordish: () => true,
      sendRuntimeMessage: (message) => { calls.push(message); return request.promise; }, showSaveNotice: (status) => notices.push(status), L: (en) => en,
    });
    const saving = context.maybeOfferSave(scope);
    assert.equal(notices.length, 0);
    assert.doesNotMatch(context.lastSaveKey, /ci-sensitive-value/);
    request.resolve(response); await saving;
    assert.deepEqual(notices, [response.status]);
    await context.maybeOfferSave(scope);
    assert.equal(calls.length, 1);
    assert.match(context.saveStatusMessage('submitted'), /Confirm the save/);
    assert.doesNotMatch(context.saveStatusMessage('submitted'), /saved successfully|已保存/i);
  });
}
