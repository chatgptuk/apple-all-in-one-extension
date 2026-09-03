(() => {
  const LOWER = 'abcdefghijklmnopqrstuvwxyz';
  const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIGITS = '0123456789';
  const SYMBOLS = '!@#$%^&*_=+?';
  const DEFAULT_LENGTH = 20;
  const MIN_SECURE_LENGTH = 8;
  const MAX_GENERATED_LENGTH = 128;

  function randomBelow(limit) {
    const max = 0x100000000;
    const ceiling = max - (max % limit);
    const values = new Uint32Array(1);
    do crypto.getRandomValues(values);
    while (values[0] >= ceiling);
    return values[0] % limit;
  }

  function pick(characters) {
    return characters[randomBelow(characters.length)];
  }

  function shuffle(characters) {
    for (let index = characters.length - 1; index > 0; index -= 1) {
      const swapIndex = randomBelow(index + 1);
      [characters[index], characters[swapIndex]] = [
        characters[swapIndex],
        characters[index],
      ];
    }
    return characters.join('');
  }

  function boundedInteger(value, fallback) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) return fallback;
    return Math.min(number, MAX_GENERATED_LENGTH);
  }

  function patternLengthRange(pattern) {
    if (!pattern || pattern.length > 256) return {};
    const trailing = pattern.match(/\{(\d{1,3})(?:,(\d{0,3}))?\}\)?\$?$/);
    if (!trailing) return {};
    const minLength = boundedInteger(trailing[1], undefined);
    const maxLength =
      trailing[2] === undefined || trailing[2] === ''
        ? minLength
        : boundedInteger(trailing[2], undefined);
    return { minLength, maxLength };
  }

  function compileHtmlPattern(pattern) {
    if (!pattern || pattern.length > 256) return null;
    try {
      return new RegExp(`^(?:${pattern})$`, 'v');
    } catch {
      try {
        return new RegExp(`^(?:${pattern})$`, 'u');
      } catch {
        return null;
      }
    }
  }

  function meetsRequirements(password, requirements, pattern) {
    if (requirements.requireLower && !/[a-z]/.test(password)) return false;
    if (requirements.requireUpper && !/[A-Z]/.test(password)) return false;
    if (requirements.requireDigit && !/\d/.test(password)) return false;
    if (requirements.requireSymbol && !/[^A-Za-z0-9]/.test(password))
      return false;
    if (requirements.forbidSymbols && /[^A-Za-z0-9]/.test(password))
      return false;
    return !pattern || pattern.test(password);
  }

  function compatibleProfiles(requirements, allowSymbols) {
    const symbolCharacters =
      String(requirements.allowedSymbols || '')
        .split('')
        .filter(
          (character, index, all) =>
            SYMBOLS.includes(character) && all.indexOf(character) === index
        )
        .join('') || SYMBOLS;
    const symbolsEnabled = allowSymbols && !requirements.forbidSymbols;
    const profiles = [
      {
        lower: true,
        upper: true,
        digit: true,
        symbols: symbolsEnabled ? symbolCharacters : '',
      },
      { lower: true, upper: true, digit: true, symbols: '' },
      { lower: true, upper: false, digit: true, symbols: '' },
      { lower: false, upper: true, digit: true, symbols: '' },
      { lower: true, upper: true, digit: false, symbols: '' },
      { lower: true, upper: false, digit: false, symbols: '' },
      { lower: false, upper: true, digit: false, symbols: '' },
    ];
    return profiles.filter((profile) => {
      if (requirements.requireLower && !profile.lower) return false;
      if (requirements.requireUpper && !profile.upper) return false;
      if (requirements.requireDigit && !profile.digit) return false;
      if (requirements.requireSymbol && !profile.symbols) return false;
      return profile.lower || profile.upper || profile.digit || profile.symbols;
    });
  }

  function buildCandidate(length, profile) {
    const required = [];
    const pools = [];
    if (profile.lower) {
      required.push(pick(LOWER));
      pools.push(LOWER);
    }
    if (profile.upper) {
      required.push(pick(UPPER));
      pools.push(UPPER);
    }
    if (profile.digit) {
      required.push(pick(DIGITS));
      pools.push(DIGITS);
    }
    if (profile.symbols) {
      required.push(pick(profile.symbols));
    }
    if (!pools.length && profile.symbols) pools.push(profile.symbols);
    const all = pools.join('');
    while (required.length < length) required.push(pick(all));
    return shuffle(required);
  }

  function generateCompatiblePassword(input = {}, options = {}) {
    const requirements = input && typeof input === 'object' ? input : {};
    const patternRange = patternLengthRange(String(requirements.pattern || ''));
    const explicitMin = boundedInteger(requirements.minLength, undefined);
    const explicitMax = boundedInteger(requirements.maxLength, undefined);
    const minLength = Math.max(
      MIN_SECURE_LENGTH,
      explicitMin || 0,
      patternRange.minLength || 0
    );
    const maxLength = Math.min(
      explicitMax || MAX_GENERATED_LENGTH,
      patternRange.maxLength || MAX_GENERATED_LENGTH
    );
    if (maxLength < MIN_SECURE_LENGTH || minLength > maxLength) {
      return { password: '', compatible: false, reason: 'length' };
    }

    const length = Math.min(maxLength, Math.max(DEFAULT_LENGTH, minLength));
    const pattern = compileHtmlPattern(String(requirements.pattern || ''));
    const profiles = compatibleProfiles(
      requirements,
      options.allowSymbols !== false
    );
    for (const profile of profiles) {
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const password = buildCandidate(length, profile);
        if (meetsRequirements(password, requirements, pattern)) {
          return {
            password,
            compatible: true,
            adapted: Boolean(
              explicitMin ||
              explicitMax ||
              requirements.pattern ||
              requirements.requireLower ||
              requirements.requireUpper ||
              requirements.requireDigit ||
              requirements.requireSymbol ||
              requirements.forbidSymbols ||
              requirements.allowedSymbols
            ),
          };
        }
      }
    }
    return { password: '', compatible: false, reason: 'pattern' };
  }

  globalThis.AppleAllInOnePasswordGenerator = Object.freeze({
    generateCompatiblePassword,
  });
})();
