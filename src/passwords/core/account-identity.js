// Usernames are identifiers, not display strings: case, whitespace and Unicode
// can distinguish accounts. Never silently substitute a different account.
/** @param {unknown} value */
export function accountKey(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @template {{username?: string, code?: unknown}} T
 * @param {T[]} items
 * @param {unknown} username
 * @returns {T | undefined}
 */
export function selectAccountCode(items, username) {
  const candidates = items.filter((item) => item.code);
  if (typeof username === 'string') {
    return candidates.find((item) => accountKey(item.username) === username);
  }
  // An unspecified account is safe only when there is no ambiguity.
  return candidates.length === 1 ? candidates[0] : undefined;
}
