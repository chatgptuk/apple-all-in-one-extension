/** @param {unknown} value */
export function positivePasswordLength(value) {
  const length = Number(value);
  return Number.isSafeInteger(length) && length > 0 ? length : undefined;
}

/** Extract explicit requirements, not every occurrence of 'uppercase'/'symbol'.
 * @param {string} text */
export function passwordHints(text) {
  const range = text.match(
    /(?:between\s+)?(\d{1,4})\s*(?:[-–—~～至到]|to|and)\s*(\d{1,4})\s*(?:characters?|chars?|位|个字符|個字元)/i
  );
  const min =
    range?.[1] ||
    text.match(
      /(?:at least|minimum|min\.?|no fewer than|至少|最少|不得少于)\s*(\d{1,4})\s*(?:characters?|chars?|位|个字符|個字元)/i
    )?.[1];
  const max =
    range?.[2] ||
    text.match(
      /(?:at most|maximum|max\.?|no more than|至多|最多|不得超过)\s*(\d{1,4})\s*(?:characters?|chars?|位|个字符|個字元)/i
    )?.[1];
  const clauses = text
    .split(/[。;；!\n]|\.(?:\s|$)/)
    .filter(
      (clause) =>
        !/not (?:required|necessary)|optional|need not|不要求|无需|無需|不必|可选|可選|非必需/i.test(
          clause
        )
    );
  /** @param {RegExp} category */
  const requires = (category) =>
    clauses.some(
      (clause) =>
        category.test(clause) &&
        /must|requires?|at least (?:one|\d+)|include|contain|至少|必须|必須|包含/i.test(
          clause
        )
    );
  const forbidSymbols =
    /alphanumeric\s+only|letters?\s+and\s+(?:numbers?|digits?)\s+only|no\s+(?:special\s+)?(?:characters?|symbols?)|只能使用字母和数字|仅限字母和数字|不允许(?:特殊)?符号|不得包含(?:特殊)?符号/i.test(
      text
    );
  const allowedSymbols = text.match(
    /(?:allowed|valid|permitted|use only|可用|允许|僅限|仅限)(?:\s+(?:special\s+)?(?:characters?|symbols?|字符|符号))?\s*[:：]?\s*([!@#$%^&*_=+?.:,;~|/\-]{1,32})(?=\s|$)/i
  )?.[1];
  return {
    minLength: positivePasswordLength(min),
    maxLength: positivePasswordLength(max),
    requireLower: requires(
      /lowercase|lower-case|small letter|小写字母|小寫字母/i
    ),
    requireUpper: requires(
      /uppercase|upper-case|capital letter|大写字母|大寫字母/i
    ),
    requireDigit: requires(/number|digit|数字|數字/i),
    requireSymbol:
      !forbidSymbols &&
      requires(/special character|symbol|特殊字符|特殊字元|符号|符號/i),
    forbidSymbols,
    allowedSymbols,
  };
}
