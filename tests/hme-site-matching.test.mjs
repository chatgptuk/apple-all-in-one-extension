import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs, read } from './source-harness.mjs';

const matching = loadTs('src/hme-site-matching.ts');
const { normalizeHmeHost, matchHmeAliases } = matching;
const { HmeSiteLinkRepository } = loadTs('src/hme-site-links.ts', { './hme-site-matching': matching });
const alias = (id, domain, created, active = true) => ({ anonymousId: id, domain, createTimestamp: created, isActive: active, hme: `${id}@icloud.com` });

test('matching orders exact then explicit then related, excludes inactive and lookalike domains', () => {
  const aliases = [alias('parent', 'example.test', 40), alias('linked', 'other.test', 30), alias('exact', 'www.example.test', 1), alias('disabled', 'www.example.test', 99, false), alias('evil', 'evil-example.test', 100)];
  assert.deepEqual(Array.from(matchHmeAliases(aliases, 'www.example.test', { linked: ['www.example.test'] }), ({ email }) => email.anonymousId), ['exact', 'linked', 'parent']);
  assert.equal(matchHmeAliases(aliases, 'www.example.test', {}, { includeInactive: true }).some(({ email }) => email.anonymousId === 'disabled'), true);
  assert.deepEqual(Array.from(matchHmeAliases(aliases, 'child.other.test', { linked: ['www.example.test'] }), ({ email }) => email.anonymousId), ['linked']);
  assert.equal(normalizeHmeHost('HTTPS://EXAMPLE.TEST./signup'), 'example.test');
  for (const value of ['javascript:alert(1)', 'user@example.test', 'some label', 'https://user:password@example.test', '', null]) assert.equal(normalizeHmeHost(value), undefined);
});

test('local links serialize writes, isolate Apple accounts and support unlink without credentials', async () => {
  let stored = {};
  const links = new HmeSiteLinkRepository({ read: async () => stored, write: async value => { stored = value; } });
  await Promise.all([links.set('region\nA', 'one', ['EXAMPLE.test']), links.set('region\nA', 'two', ['else.test'])]);
  await links.set('region\nB', 'one', ['account-b.test']);
  assert.deepEqual(Object.keys(await links.list('region\nA')), ['one', 'two']);
  assert.equal((await links.list('region\nB')).one[0], 'account-b.test');
  await links.set('region\nA', 'one', []);
  assert.equal((await links.list('region\nA')).one, undefined);
  assert.equal((await links.list('region\nB')).one[0], 'account-b.test');
  assert.throws(() => links.set('region\n', 'one', ['example.test']), /Reconnect/);
  assert.throws(() => links.set('region\nA', '__proto__', ['example.test']), /identifier/);
  assert.throws(() => links.set('region\nA', 'one', ['not a host']), /hostnames/);
});

test('secure chooser exposes address selection and old numeric mutation producers remain absent', () => {
  const inline = read('src/passwords/inline.js');
  assert.match(inline, /state\.existingHmes/);
  assert.match(inline, /existingHme: state\.existingHme\?\.hme/);
  for (const path of ['src/passwords/content.js', 'src/passwords/inline.js', 'src/pages/Content/script.ts', 'src/pages/Popup/Popup.tsx']) {
    assert.doesNotMatch(read(path), /MessageType\.(GenerateRequest|ReservationRequest)/);
  }
});
