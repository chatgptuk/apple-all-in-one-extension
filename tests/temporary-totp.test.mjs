import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHmac } from 'node:crypto';
import { loadTs, deferred } from './source-harness.mjs';

const totp = loadTs('src/passwords/totp.ts', {}, { crypto: webcrypto });
const { createTotp } = totp;
const { createTemporaryTotpSession } = loadTs('src/pages/Popup/temporary-totp-session.ts', { '../../passwords/totp': totp });
// Test-only encoder for public RFC vectors, never production credentials.
function base32(text) {
  const bits = [...Buffer.from(text)].map((byte) => byte.toString(2).padStart(8, '0')).join('');
  return bits.match(/.{1,5}/g).map((chunk) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(chunk.padEnd(5, '0'), 2)]).join('');
}
const rfcKey = base32('12345678901234567890');

test('TOTP matches all RFC 6238 Appendix B vectors for SHA1, SHA256 and SHA512', async () => {
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  for (const [index, algorithm, length] of [[1, 'SHA1', 20], [2, 'SHA256', 32], [3, 'SHA512', 64]]) {
    const secret = base32('1234567890'.repeat(7).slice(0, length));
    const generator = await createTotp(`otpauth://totp/PublicRFCVector?secret=${secret}&algorithm=${algorithm}&digits=8`);
    for (const row of vectors) assert.equal((await generator.generate(row[0] * 1000)).code, row[index]);
  }
});

test('plain setup keys default to six digits and 30 seconds, accepting grouped lowercase and canonical padding', async () => {
  const generator = await createTotp(rfcKey.toLowerCase().match(/.{1,4}/g).join(' - '));
  assert.deepEqual({ ...await generator.generate(59_000) }, { code: '287082', startsAt: 30_000, expiresAt: 60_000, period: 30 });
  assert.equal((await generator.generate(1111111109_000)).code, '081804', 'preserve leading zeros');
  const padded = `${base32('12345678901')}======`;
  assert.equal((await (await createTotp(padded)).generate(59_000)).code, (await (await createTotp(padded.replace(/=/g, ''))).generate(59_000)).code);
});

test('custom TOTP periods and high counter bytes are honored', async () => {
  const generator = await createTotp(`otpauth://totp/Test?secret=${rfcKey}&digits=7&period=60`);
  assert.equal((await generator.generate(60_000)).code, '4287082');
  assert.equal((await generator.generate(59_999)).expiresAt, 60_000);
  const step = 0x100000001, bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', '12345678901234567890').update(bytes).digest();
  const expected = String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 10 ** 7).padStart(7, '0');
  assert.equal((await generator.generate(step * 60_000)).code, expected);
});

test('invalid keys and unsupported or ambiguous setup links fail without echoing the input', async () => {
  for (const input of ['', 'SHORT', 'JBSWY3DPEHPK3PX0', 'JBSWY3DPEHPK3PX1', 'JBSWY3DPEHPK3PX!',
    `${rfcKey}=`, 'A'.repeat(17), `${base32('12345678901').slice(0, -1)}B`, 'A'.repeat(4097),
    `otpauth://hotp/Test?secret=${rfcKey}`, `otpauth://totp/Test?secret=${rfcKey}&digits=4`,
    `otpauth://totp/Test?secret=${rfcKey}&secret=${rfcKey}`, `otpauth://totp/Test?secret=${rfcKey}&algorithm=MD5`,
    `otpauth://totp/Test?secret=${rfcKey}&period=0`, `otpauth://totp/Test?secret=${rfcKey}&period=301`,
    `otpauth://totp/Test?secret=${rfcKey}&algorithm=`, 'https://private.test/?secret=PRIVATE']) {
    await assert.rejects(createTotp(input), (error) => {
      assert.ok(['invalid_key', 'unsupported_uri', 'unsupported_options'].includes(error.code));
      assert.equal(error.message, error.code);
      return true;
    });
  }
});

test('keys are imported nonextractable and temporary decoded key bytes are cleared', async () => {
  let seen;
  const { createTotp: inspect } = loadTs('src/passwords/totp.ts', {}, { crypto: { subtle: {
    async importKey(format, bytes, algorithm, extractable, usages) {
      seen = { format, bytes, algorithm, extractable, usages };
      assert.ok(bytes.some((byte) => byte !== 0));
      return {};
    },
  } } });
  await inspect(rfcKey);
  assert.equal(seen.extractable, false);
  assert.deepEqual([...seen.usages], ['sign']);
  assert.ok(seen.bytes.every((byte) => byte === 0));
});

function harness(prepare) {
  let time = 29_000, sequence = 0;
  const timers = new Map(), states = [], requests = [];
  const generate = async (now) => {
    requests.push(now);
    const step = Math.floor(now / 30_000);
    return { code: String(step + 1).padStart(6, '0'), startsAt: step * 30_000, expiresAt: (step + 1) * 30_000, period: 30 };
  };
  const session = createTemporaryTotpSession((state) => states.push(state), {
    prepare: prepare || (async () => ({ generate })), now: () => time,
    setTimer(fn) { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return {
    session, states, timers, requests, generate,
    get state() { return states.at(-1); },
    time(value) { time = value; },
    async tick() {
      for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
      for (let i = 0; i < 15; i++) await Promise.resolve();
    },
  };
}

test('the countdown rolls at the real step boundary and handles clock jumps without counting ticks', async () => {
  const h = harness();
  await h.session.setInput('synthetic');
  assert.equal(h.state.code, '000001');
  assert.equal(h.state.seconds, 1);
  h.time(30_000); await h.tick();
  assert.equal(h.state.code, '000002');
  assert.equal(h.state.seconds, 30);
  h.time(360_000); await h.tick();
  assert.equal(h.state.code, '000013');
  h.time(0); await h.tick();
  assert.equal(h.state.code, '000001');
  h.session.dispose();
  assert.equal(h.timers.size, 0);
});

test('copy recalculates a fresh code after timer throttling and reports clipboard errors without losing it', async () => {
  const h = harness(), copied = [];
  await h.session.setInput('synthetic');
  h.time(90_000);
  assert.equal(await h.session.copy(async (code) => copied.push(code)), true);
  assert.deepEqual(copied, ['000004']);
  assert.equal(h.state.copyNotice, 'copied');
  await h.session.copy(async () => { throw new Error('denied'); });
  assert.equal(h.state.copyNotice, 'failed');
  assert.equal(h.state.code, '000004');
  h.session.dispose();
});

for (const action of ['clear', 'replace', 'dispose']) {
  test(`${action} prevents a late imported key from restoring codes or timers`, async () => {
    const pending = deferred();
    const h = harness((input) => input === 'old-private-key' ? pending.promise : Promise.reject(new totp.TotpError('invalid_key')));
    const old = h.session.setInput('old-private-key');
    if (action === 'dispose') h.session.dispose();
    else await h.session.setInput(action === 'clear' ? '' : 'invalid-new-key');
    const count = h.states.length;
    pending.resolve({ generate: h.generate });
    await old;
    assert.equal(h.states.length, count);
    assert.equal(h.requests.length, 0);
    assert.equal(h.timers.size, 0);
    assert.doesNotMatch(JSON.stringify(h.states), /old-private-key|invalid-new-key/);
    h.session.dispose();
  });
}

test('disposing during code generation or copying cannot publish or copy a late result', async () => {
  const pending = deferred();
  const h = harness(async () => ({ generate: () => pending.promise }));
  const loading = h.session.setInput('synthetic');
  await Promise.resolve();
  const copied = [];
  const copying = h.session.copy(async (code) => copied.push(code));
  h.session.dispose();
  const count = h.states.length;
  pending.resolve({ code: '123456', startsAt: 0, expiresAt: 30_000, period: 30 });
  await loading; await copying;
  assert.equal(h.states.length, count);
  assert.deepEqual(copied, []);
  assert.equal(h.timers.size, 0);
});

test('a signature completing after its code expires is never displayed or copied', async () => {
  const pending = deferred();
  const h = harness(async () => ({ generate: () => pending.promise }));
  const loading = h.session.setInput('synthetic');
  await Promise.resolve();
  h.time(30_001);
  pending.resolve({ code: 'old-code', startsAt: 0, expiresAt: 30_000, period: 30 });
  await loading;
  assert.equal(h.state.code, undefined);
  let writes = 0;
  assert.equal(await h.session.copy(async () => { writes++; }), false);
  assert.equal(writes, 0);
  h.session.dispose();
});
