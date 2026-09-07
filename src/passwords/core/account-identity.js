// Usernames are identifiers, not display strings: case, whitespace and Unicode
// can distinguish accounts. Never silently substitute a different account.
import { selectUniqueSecretForHost } from './login-order.js';
/** @param {unknown} value */
export function accountKey(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @template {{username?: string, code?: unknown, domain?: unknown, sites?: unknown}} T
 * @param {T[]} items
 * @param {unknown} username
 * @param {unknown} [host]
 * @returns {T | undefined}
 */
export function selectAccountCode(items, username, host) {
  const candidates = items.filter((item) => item.code);
  if (typeof username === 'string') {
    return selectUniqueSecretForHost(host, candidates.filter((item) => accountKey(item.username) === username), (item) => item.code);
  }
  // An unspecified account is safe only when there is no ambiguity.
  const accounts = new Set(candidates.map((item) => accountKey(item.username)));
  return accounts.size === 1 ? selectUniqueSecretForHost(host, candidates, (item) => item.code) : undefined;
}
