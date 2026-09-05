import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { randomToken } from '../src/passwords/random-token.js';
import { contentMessageHandler } from './source-harness.mjs';

const httpCrypto = { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) };

test('HTTP content scripts generate secure UUID v4 tokens without randomUUID', () => {
  const tokens = new Set(Array.from({ length: 1000 }, () => randomToken(httpCrypto)));
  assert.equal(tokens.size, 1000);
  for (const token of tokens) assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('secure-context token generation uses native randomUUID with its receiver', () => {
  assert.match(randomToken(webcrypto), /^[0-9a-f-]{36}$/);
  const source = { randomUUID() { assert.equal(this, source); return 'native-token'; } };
  assert.equal(randomToken(source), 'native-token');
});

test('HTTP prepareFill creates a fresh one-use lease and retains origin checks', () => {
  const location = { href: 'http://example.test:16851/', origin: 'http://example.test:16851', hostname: 'example.test' };
  const context = contentMessageHandler({
    crypto: httpCrypto,
    randomToken: () => randomToken(httpCrypto),
    documentToken: randomToken(httpCrypto),
    chrome: { runtime: { id: 'extension' } },
    location,
    HTMLInputElement: class {},
    deepActiveElement: () => null,
    uiAnchor: null, fillAnchor: null, pendingFill: null,
    firstVisibleOtpField: () => null,
    document: { querySelectorAll: () => [] },
  });
  const prepare = (origin = location.origin) => {
    let response;
    context.listener({ type: 'prepareFill', expectedOrigin: origin }, { id: 'extension' }, (value) => { response = value; });
    return response;
  };
  const first = prepare(), second = prepare();
  assert.equal(first.ok, true);
  assert.equal(first.documentToken, second.documentToken);
  assert.notEqual(first.targetToken, second.targetToken);
  assert.equal(prepare('https://example.test').ok, false);
});
