// Local-only RFC 6238 / RFC 4226 TOTP. No storage, messaging or network access.
export type TotpErrorCode = 'invalid_key' | 'unsupported_uri' | 'unsupported_options' | 'unavailable';
export class TotpError extends Error {
  constructor(public readonly code: TotpErrorCode) { super(code); }
}
export type TotpValue = { code: string; startsAt: number; expiresAt: number; period: number };
export type TotpGenerator = { generate: (now?: number) => Promise<TotpValue> };

function decodeBase32(input: string): Uint8Array<ArrayBuffer> {
  const text = input.replace(/[\s-]/g, '').toUpperCase();
  const match = /^([A-Z2-7]+)(=*)$/.exec(text);
  if (!match || match[1].length > 1024) throw new TotpError('invalid_key');
  const [, data, padding] = match;
  const remainder = data.length % 8;
  if (![0, 2, 4, 5, 7].includes(remainder) ||
      (padding && (text.length % 8 !== 0 || padding.length !== (8 - remainder) % 8)))
    throw new TotpError('invalid_key');
  const bytes = new Uint8Array(Math.floor(data.length * 5 / 8));
  // Common setup keys use at least 80 bits; do not interpret a partial key as complete.
  if (bytes.length < 10) throw new TotpError('invalid_key');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0, bits = 0, index = 0;
  for (const char of data) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >>> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) { bytes.fill(0); throw new TotpError('invalid_key'); }
  return bytes;
}

export async function createTotp(input: string): Promise<TotpGenerator> {
  if (typeof input !== 'string' || input.length > 4096) throw new TotpError('invalid_key');
  let secret = input.trim(), algorithm = 'SHA-1', digits = 6, period = 30;
  if (/^otpauth:/i.test(secret)) {
    let uri: URL;
    try { uri = new URL(secret); } catch { throw new TotpError('unsupported_uri'); }
    if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || uri.username || uri.password || uri.port || uri.hash)
      throw new TotpError('unsupported_uri');
    const params = uri.searchParams;
    for (const name of ['secret', 'algorithm', 'digits', 'period']) {
      if (params.getAll(name).length > 1) throw new TotpError('unsupported_options');
    }
    secret = params.get('secret') || '';
    const hash = (params.get('algorithm') ?? 'SHA1').toUpperCase();
    const hashes: Record<string, string> = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };
    const digitText = params.get('digits') ?? '6', periodText = params.get('period') ?? '30';
    if (!hashes[hash] || !/^[678]$/.test(digitText) || !/^\d{1,3}$/.test(periodText))
      throw new TotpError('unsupported_options');
    algorithm = hashes[hash]; digits = Number(digitText); period = Number(periodText);
    if (period < 1 || period > 300) throw new TotpError('unsupported_options');
  }
  const bytes = decodeBase32(secret);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: algorithm }, false, ['sign']);
  } catch { throw new TotpError('unavailable'); }
  finally { bytes.fill(0); }
  return {
    async generate(now = Date.now()) {
      if (!Number.isSafeInteger(now) || now < 0) throw new TotpError('unavailable');
      const step = Math.floor(now / (period * 1000));
      const counter = new ArrayBuffer(8), view = new DataView(counter);
      view.setUint32(0, Math.floor(step / 0x100000000));
      view.setUint32(4, step >>> 0);
      const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
      const offset = mac[mac.length - 1] & 15;
      const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
      return {
        code: String(binary % 10 ** digits).padStart(digits, '0'),
        startsAt: step * period * 1000,
        expiresAt: (step + 1) * period * 1000,
        period,
      };
    },
  };
}
