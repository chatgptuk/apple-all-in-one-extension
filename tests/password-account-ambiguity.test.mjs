import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplePasswords, State } from '../src/passwords/core/protocol.js';
import { selectAccountCode } from '../src/passwords/core/account-identity.js';
import { describeLoginCandidatesForHost, selectUniqueSecretForHost } from '../src/passwords/core/login-order.js';

function nativeReply(entries) {
  const client = new ApplePasswords();
  client.port = {};
  client.session = { sharedKey: 'synthetic' };
  client.state = State.Unlocked;
  const queries = [];
  client._encryptedQuery = async (...args) => {
    queries.push(args);
    return { STATUS: 0, Entries: entries };
  };
  return { client, queries };
}
const entry = (site, password, username = 'Admin') => ({ USR: username, PWD: password, sites: [site] });
const ambiguity = error => error.code === 'ambiguous_account' && error.reason === 'ambiguous_account' && !/SyntheticSecret|111111|222222/.test(error.message);

test('native password read chooses unique exact host over earlier related account; caller sites cannot redirect it', async () => {
  const { client, queries } = nativeReply([
    entry('account.example.test', 'RelatedSyntheticSecret'),
    entry('login.example.test', 'ExactSyntheticSecret'),
  ]);
  const result = await client.getPasswordForLoginName(1, 'https://login.example.test/path', { username: 'Admin', sites: ['account.example.test'] });
  assert.equal(result.password, 'ExactSyntheticSecret');
  assert.equal(queries[0][2], 'login.example.test');
  assert.equal(queries[0][3].URL, 'login.example.test');
});

test('native same-account aliases with identical secrets collapse but distinct exact or fallback secrets fail closed', async () => {
  for (const sites of [['one.example.test', 'two.example.test'], ['login.example.test', 'login.example.test']]) {
    const same = nativeReply(sites.map(site => entry(site, 'SameSyntheticSecret'))).client;
    assert.equal((await same.getPasswordForLoginName(1, 'https://login.example.test', { username: 'Admin' })).password, 'SameSyntheticSecret');
    const different = nativeReply(sites.map((site, index) => entry(site, `${index}SyntheticSecret`))).client;
    await assert.rejects(different.getPasswordForLoginName(1, 'https://login.example.test', { username: 'Admin' }), ambiguity);
  }
});

test('native ambiguity checks never conflate case-sensitive or Unicode-distinct accounts', async () => {
  const { client } = nativeReply([
    entry('login.example.test', 'lowercase', 'admin'),
    entry('login.example.test', 'uppercase', 'Admin'),
    entry('login.example.test', 'spaced', ' Admin'),
  ]);
  assert.equal((await client.getPasswordForLoginName(1, 'https://login.example.test', { username: 'Admin' })).password, 'uppercase');
  assert.equal(await client.getPasswordForLoginName(1, 'https://login.example.test', { username: 'ADMIN' }), undefined);
});

test('OTP selection honors exact domain, rejects different codes for ambiguous account and folds identical aliases', () => {
  const items = [
    { username: 'Admin', domain: 'related.example.test', code: '111111' },
    { username: 'Admin', domain: 'login.example.test', code: '222222' },
    { username: 'admin', domain: 'login.example.test', code: '333333' },
  ];
  assert.equal(selectAccountCode(items, 'Admin', 'login.example.test').code, '222222');
  assert.equal(selectAccountCode(items, 'admin', 'login.example.test').code, '333333');
  assert.throws(() => selectAccountCode(items, 'Admin', 'other.example.test'), ambiguity);
  assert.throws(() => selectAccountCode(items.slice(0, 2), 'Admin'), ambiguity);
  assert.equal(selectAccountCode(items, undefined, 'login.example.test'), undefined);
  assert.equal(selectAccountCode(items.slice(0, 2).map(item => ({ ...item, code: '444444' })), 'Admin').code, '444444');
});

test('login-source annotations expose only safe metadata and advise rather than block source ambiguity', () => {
  const metadata = [
    { username: 'Admin', sites: ['https://one.example.test/login?token=not-for-ui'], password: 'SyntheticSecret', code: '111111' },
    { username: 'Admin', sites: ['two.example.test'], note: 'private' },
  ];
  const related = describeLoginCandidatesForHost('login.example.test', metadata);
  assert.equal(related[0].sourceWebsite, 'one.example.test');
  assert.equal(related[0].match, 'related');
  assert.equal(related[0].ambiguous, true);
  assert.doesNotMatch(JSON.stringify(related), /SyntheticSecret|111111|token|private|password/);
  const exact = describeLoginCandidatesForHost('one.example.test', metadata);
  assert.equal(exact[0].match, 'exact');
  assert.equal(exact[0].ambiguous, false);
  assert.equal(selectUniqueSecretForHost('login.example.test', [], item => item.password), undefined);
});

test('queued password and OTP reveals expire before touching native and do not poison later requests', async () => {
  await Promise.all(['password', 'otp'].map(async (kind) => {
    const { client, queries } = nativeReply([entry('login.example.test', 'SyntheticSecret')]);
    let release;
    client._lock = new Promise(resolve => { release = resolve; });
    const request = () => kind === 'password'
      ? client.getPasswordForLoginName(1, 'https://login.example.test', { username: 'Admin' })
      : client.getOneTimeCodeForURL(1, 'https://login.example.test');
    const queued = request();
    await assert.rejects(queued, /busy; retry the lookup/);
    assert.equal(queries.length, 0, `${kind} must not contact native while queued`);
    release();
    await client._lock;
    assert.equal(queries.length, 0, `${kind} expired task must not open a late Touch ID prompt`);
    await request();
    assert.equal(queries.length, 1, `${kind} fresh request can still run`);
    assert.equal(queries[0][4], 60_000, 'active Touch ID authorization timeout remains 60 seconds');
  }));
});
