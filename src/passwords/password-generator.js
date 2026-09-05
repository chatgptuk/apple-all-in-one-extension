// Shared by the extension-origin chooser and its tests. No secret is exposed
// to the page until the user explicitly chooses to fill it.
(() => {
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIGITS = '0123456789';
  const SYMBOLS = '!@#$%^&*_=+?';
  const PRINTABLE = Array.from({ length: 94 }, (_, i) =>
    String.fromCharCode(i + 33)
  )
    .filter((c) => c !== '-')
    .join('');
  const MAX_LENGTH = 128;
  /** @typedef {{minLength?: number, maxLength?: number, pattern?: string, requireLower?: boolean, requireUpper?: boolean, requireDigit?: boolean, requireSymbol?: boolean, forbidSymbols?: boolean, allowedSymbols?: string}} Requirements */
  /** @typedef {{pool: string, min: number, max: number}} Segment */
  /** @param {number} limit */
  function randomBelow(limit) {
    const ceiling = 0x100000000 - (0x100000000 % limit);
    const values = new Uint32Array(1);
    do crypto.getRandomValues(values);
    while (values[0] >= ceiling);
    return values[0] % limit;
  }
  /** @param {string} pool */
  const pick = (pool) => pool[randomBelow(pool.length)];
  /** @param {string} token */
  function characterPool(token) {
    try {
      const re = new RegExp(`^(?:${token})$`, 'v');
      return Array.from(PRINTABLE)
        .filter((c) => re.test(c))
        .join('');
    } catch {
      return '';
    }
  }

  /** Construct a bounded subset of HTML patterns, never execute arbitrary regex.
   * @param {string} pattern */
  function parsePattern(pattern) {
    let rest = pattern.replace(/^\^/, '').replace(/\$$/, '');
    /** @type {{pool: string, count: number}[]} */
    const required = [];
    let forbidden = '',
      lookMin = 0,
      lookMax = MAX_LENGTH;
    while (rest.startsWith('(?=') || rest.startsWith('(?!')) {
      let depth = 1,
        end = 3,
        inClass = false;
      for (; end < rest.length && depth; end++) {
        const c = rest[end];
        if (c === '\\') {
          end++;
          continue;
        }
        if (c === '[') inClass = true;
        if (c === ']') inClass = false;
        if (!inClass && c === '(') depth++;
        if (!inClass && c === ')') depth--;
      }
      if (depth) return null;
      const body = rest.slice(3, end - 1);
      const negative = rest[2] === '!';
      const length = body.match(/^\.\{(\d+)(?:,(\d*))?\}\$$/);
      const single = body.match(
        /^\.\*(\[(?:\\.|[^\]\\])+\]|\\[dwS])(?:\.\*)?\$?$/
      );
      const multiple = body.match(
        /^\(\?:\.\*(\[(?:\\.|[^\]\\])+\]|\\[dwS])\)\{(\d+)\}(?:\.\*)?\$?$/
      );
      if (length && !negative) {
        lookMin = Math.max(lookMin, Number(length[1]));
        lookMax = Math.min(
          lookMax,
          length[2] === undefined
            ? Number(length[1])
            : length[2] === ''
              ? MAX_LENGTH
              : Number(length[2])
        );
      } else if (single || multiple) {
        const pool = characterPool(
          (single || /** @type {RegExpMatchArray} */ (multiple))[1]
        );
        if (!pool) return null;
        if (negative && single) forbidden += pool;
        else if (!negative)
          required.push({ pool, count: multiple ? Number(multiple[2]) : 1 });
        else return null;
      } else return null;
      rest = rest.slice(end);
    }
    /** @type {Segment[]} */
    const segments = [];
    while (rest) {
      const token = rest.match(
        /^(\[(?:\\.|[^\]\\])+\]|\\[dwS]|\\[^a-zA-Z0-9]|[a-zA-Z0-9!@#%&_,:;=<>/]|\.)/
      );
      if (!token) return null;
      rest = rest.slice(token[0].length);
      const quantifier = rest.match(/^(?:\{(\d+)(?:,(\d*))?\}|([+*?]))/);
      let min = 1,
        max = 1;
      if (quantifier) {
        rest = rest.slice(quantifier[0].length);
        if (quantifier[3]) {
          min = quantifier[3] === '+' ? 1 : 0;
          max = quantifier[3] === '?' ? 1 : MAX_LENGTH;
        } else {
          min = Number(quantifier[1]);
          max =
            quantifier[2] === undefined
              ? min
              : quantifier[2] === ''
                ? MAX_LENGTH
                : Number(quantifier[2]);
        }
      }
      if (min > max || min > MAX_LENGTH) return null;
      const pool = Array.from(characterPool(token[0]))
        .filter((c) => !forbidden.includes(c))
        .join('');
      if (!pool) return null;
      segments.push({ pool, min, max: Math.min(max, MAX_LENGTH) });
    }
    return segments.length ? { segments, required, lookMin, lookMax } : null;
  }

  /** @param {Requirements} input @param {{allowSymbols?: boolean, length?: number, allowedSymbols?: string}} options */
  function generateCompatiblePassword(input = {}, options = {}) {
    /** @param {string} reason */
    const fail = (reason) => ({ password: '', compatible: false, reason });
    const requirements = input || {};
    if (requirements.pattern && requirements.pattern.length > 256)
      return fail('unsupported_pattern');
    const parsed = requirements.pattern
      ? parsePattern(requirements.pattern)
      : null;
    if (requirements.pattern && !parsed) return fail('unsupported_pattern');
    const symbols =
      options.allowedSymbols ?? requirements.allowedSymbols ?? SYMBOLS;
    const allowed = Array.from(symbols)
      .filter(
        (c) =>
          PRINTABLE.includes(c) &&
          !/[A-Za-z0-9]/.test(c) &&
          (requirements.allowedSymbols === undefined ||
            requirements.allowedSymbols.includes(c))
      )
      .join('');
    const forbidSymbols =
      requirements.forbidSymbols || options.allowSymbols === false;
    /** @param {string} c */
    const symbolAllowed = (c) =>
      /[A-Za-z0-9]/.test(c) || (!forbidSymbols && allowed.includes(c));
    const restrictSymbols =
      forbidSymbols ||
      requirements.allowedSymbols !== undefined ||
      options.allowedSymbols !== undefined ||
      !parsed;
    const segments = (
      parsed?.segments || [
        { pool: LOWER + UPPER + DIGITS + allowed, min: 8, max: MAX_LENGTH },
      ]
    ).map((s) => ({
      ...s,
      pool: restrictSymbols
        ? Array.from(s.pool).filter(symbolAllowed).join('')
        : s.pool,
    }));
    if (segments.some((s) => !s.pool)) return fail('symbols');
    const minLength = Math.max(
      8,
      requirements.minLength || 0,
      parsed?.lookMin || 0,
      segments.reduce((n, s) => n + s.min, 0)
    );
    const maxLength = Math.min(
      MAX_LENGTH,
      requirements.maxLength ?? MAX_LENGTH,
      parsed?.lookMax ?? MAX_LENGTH,
      segments.reduce((n, s) => n + s.max, 0)
    );
    if (minLength > maxLength) return fail('length');
    if (
      options.length !== undefined &&
      (!Number.isInteger(options.length) ||
        options.length < minLength ||
        options.length > maxLength)
    )
      return fail('length');
    const length =
      options.length ?? Math.min(maxLength, Math.max(20, minLength));
    const required = [...(parsed?.required || [])];
    for (const [flag, pool] of [
      [requirements.requireLower || !parsed, LOWER],
      [requirements.requireUpper || !parsed, UPPER],
      [requirements.requireDigit || !parsed, DIGITS],
      [
        requirements.requireSymbol || (!parsed && !forbidSymbols && !!allowed),
        parsed ? PRINTABLE.replace(/[A-Za-z0-9]/g, '') : allowed,
      ],
    ]) {
      if (flag) required.push({ pool: String(pool), count: 1 });
    }
    if (required.some((r) => r.count > length || !r.pool))
      return fail('requirements');
    // Shape/lengths are constructed. Bounded retries handle overlapping positive
    // requirements. An unsupported pattern is reported, never silently ignored.
    for (let attempt = 0; attempt < 64; attempt++) {
      const counts = segments.map((s) => s.min);
      let remaining = length - counts.reduce((a, b) => a + b, 0);
      while (remaining-- > 0) {
        const eligible = segments
          .map((s, i) => (counts[i] < s.max ? i : -1))
          .filter((i) => i >= 0);
        counts[eligible[randomBelow(eligible.length)]]++;
      }
      const pools = segments.flatMap((s, i) =>
        Array.from({ length: counts[i] }, () => s.pool)
      );
      const chars = pools.map(pick);
      for (const rule of required) {
        let missing =
          rule.count - chars.filter((c) => rule.pool.includes(c)).length;
        const candidates = pools
          .map((pool, i) => ({
            i,
            pool: Array.from(pool)
              .filter((c) => rule.pool.includes(c))
              .join(''),
          }))
          .filter((slot) => slot.pool && !rule.pool.includes(chars[slot.i]));
        while (missing-- > 0 && candidates.length) {
          const slot = candidates.splice(randomBelow(candidates.length), 1)[0];
          chars[slot.i] = pick(slot.pool);
        }
      }
      if (
        !required.every(
          (r) => chars.filter((c) => r.pool.includes(c)).length >= r.count
        )
      )
        continue;
      return {
        password: chars.join(''),
        compatible: true,
        adapted:
          Object.values(requirements).some(Boolean) ||
          options.length !== undefined,
      };
    }
    return fail('requirements');
  }
  globalThis.AppleAllInOnePasswordGenerator = Object.freeze({
    generateCompatiblePassword,
  });
})();
