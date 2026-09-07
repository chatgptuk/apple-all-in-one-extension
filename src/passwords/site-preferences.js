import { normalizeSitePreferences } from './message-contracts.js';
export const SITE_PREFERENCES_KEY = 'passwordSitePreferences';
/** @param {unknown} host */
export function validSiteHost(host) {
  if (typeof host !== 'string' || host.length > 253 || /[\s/@?#]/.test(host)) return false;
  try { return new URL(`https://${host}`).hostname === host.toLowerCase(); } catch { return false; }
}
/** @param {unknown} stored @param {string} host */
export function sitePreferencesFor(stored, host) {
  const map = stored && typeof stored === 'object' && !Array.isArray(stored) ? /** @type {Record<string, unknown>} */ (stored) : {};
  return normalizeSitePreferences(Object.hasOwn(map, host) ? map[host] : undefined);
}
