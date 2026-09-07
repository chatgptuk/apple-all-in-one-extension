import assert from 'node:assert/strict';
import test from 'node:test';
import { validPasswordRequest, validContentFillRequest, failureResult, failureMessage, failureReason, normalizeSitePreferences } from '../src/passwords/message-contracts.js';
import { sitePreferencesFor, validSiteHost } from '../src/passwords/site-preferences.js';
import { createPendingSaveQueue } from '../src/passwords/core/pending-saves.js';
import { functionsFrom, deferred } from './source-harness.mjs';

test('password message contracts reject malformed privileged requests', () => {
  for (const message of [null, [], {}, {type:'anything'}, {type:'fillOnPage',loginName:{}},
    {type:'fillOnPage',loginName:{username:'a'},mode:'export'},
    {type:'inlineFillOtp',username:'a'}, {type:'verifyPin',pin:'123'},
    {type:'resolveSave',username:'a',password:'secret'},
    {type:'setSitePreferences',preferences:{suggestions:'manual'}}]) assert.equal(validPasswordRequest(message), false);
  assert.equal(validPasswordRequest({type:'fillOnPage',loginName:{username:'A'},mode:'details'}), true);
  assert.equal(validPasswordRequest({type:'inlineFillOtp',username:'A',documentToken:'document-A'}), true);
  assert.equal(validContentFillRequest({type:'fill',username:'A',password:123,expectedDocumentToken:'d',targetToken:'t'}), false);
  assert.equal(validContentFillRequest({type:'fillOtp',code:'123456'}), false);
  assert.equal(validContentFillRequest({type:'prepareFill',expectedOrigin:{host:'bad'}}), false);
});

test('diagnostic errors have stable reasons and never echo native secrets or URLs', () => {
  const result = failureResult(new Error('timeout for https://private.example/login?secret=SensitivePassword'));
  assert.equal(result.reason, 'native_timeout');
  assert.doesNotMatch(JSON.stringify(result), /private|SensitivePassword/);
  assert.match(failureMessage('target_changed', true), /重新点击/);
  const history = [];
  const diagnostics = functionsFrom('src/passwords/core/background.js', ['recordDiagnostic'], {recentDiagnosticEvents:history, failureReason});
  diagnostics.recordDiagnostic('fill https://private.example?secret=SensitivePassword', 'unavailable');
  assert.equal(history[0].operation, 'unknown');
  assert.doesNotMatch(JSON.stringify(history), /private|SensitivePassword/);
});

test('site preferences use exact hostname and safe defaults', () => {
  const stored = { 'accounts.example.test': {suggestions:'manual',privateSignup:false} };
  assert.deepEqual(sitePreferencesFor(stored, 'accounts.example.test'), stored['accounts.example.test']);
  assert.deepEqual(sitePreferencesFor(stored, 'other.example.test'), {suggestions:'automatic',privateSignup:true});
  assert.deepEqual(normalizeSitePreferences(null), {suggestions:'automatic',privateSignup:true});
  for (const host of ['https://example.test', 'example.test/path', 'a@b.test', 'a.test?x']) assert.equal(validSiteHost(host), false);
});

test('save queue flush is single-flight and never submits expired entries after a slow lookup', async () => {
  let now = 100;
  const waiting = deferred();
  const queue = createPendingSaveQueue({now:()=>now, ttlMs:1000, setTimer:()=>0, clearTimer:()=>{}});
  const statuses = [], saves = [];
  queue.enqueue({host:'example.test',detected:'A',password:'secret-A',tabId:1,frameUrl:'https://example.test'});
  queue.enqueue({host:'example.test',detected:'B',password:'secret-B',tabId:1,frameUrl:'https://example.test'});
  const context = functionsFrom('src/passwords/core/background.js', ['flushPendingSaves'], {
    flushingPendingSaves:false, pendingSaves:queue, Date:{now:()=>now},
    client:{ready:true,getLoginNamesForURL:()=>waiting.promise,saveLogin:async(...args)=>saves.push(args)},
    pickSaveTarget:(save)=>save.detected, setSaveStatus:(_tab,status)=>statuses.push(status),recordDiagnostic:()=>{},failureReason:()=> 'unavailable',
  });
  const first = context.flushPendingSaves();
  await context.flushPendingSaves();
  assert.equal(queue.size, 1, 'second invocation must not consume another pending save');
  now = 1200;
  waiting.resolve([]);
  await first;
  assert.equal(saves.length, 0);
  assert.ok(statuses.includes('expired'));
  assert.equal(context.flushingPendingSaves, false);
});
