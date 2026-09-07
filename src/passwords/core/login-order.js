/** @typedef {{ username?: string, sites?: unknown, highLevelDomain?: unknown, domain?: unknown }} LoginSiteMetadata */

/** @param {unknown} value */
function normalizedHostname(value) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim().toLowerCase();
  if (!candidate) return null;

  // Apple normally returns absolute URLs or bare hostnames in `sites`. Tolerate
  // wildcard-style host metadata as well, but keep www/subdomains distinct so an
  // "exact" match really is exact.
  candidate = candidate.replace(/^\*\./, '');
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(candidate)
        ? candidate
        : `https://${candidate}`
    );
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/** @param {unknown} value @param {Set<string>} output @param {Set<object>} seen */
function collectSiteHostnames(value, output, seen = new Set()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number')
    return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^[\[{]/.test(trimmed)) {
      try {
        collectSiteHostnames(JSON.parse(trimmed), output, seen);
        return;
      } catch (_) {}
    }
    const host = normalizedHostname(trimmed);
    if (host) output.add(host);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry) => collectSiteHostnames(entry, output, seen));
    return;
  }

  // Helper versions have returned both URL-shaped objects and dictionaries keyed
  // by site. Inspect both values and hostname-looking keys to keep the ordering
  // compatible without trusting this metadata for the actual password read.
  for (const [key, nested] of Object.entries(value)) {
    collectSiteHostnames(nested, output, seen);
    if (key.includes('.') || key.includes('://')) {
      const host = normalizedHostname(key);
      if (host) output.add(host);
    }
  }
}

/** @param {LoginSiteMetadata | undefined} login */
function loginSiteHosts(login) {
  const sites = new Set();
  collectSiteHostnames(login?.sites, sites);
  collectSiteHostnames(login?.highLevelDomain, sites);
  collectSiteHostnames(login?.domain, sites);
  return sites;
}

/** @param {unknown} host @param {LoginSiteMetadata | undefined} login */
export function loginExactlyMatchesHost(host, login) {
  const target = normalizedHostname(host);
  if (!target) return false;
  return loginSiteHosts(login).has(target);
}

/**
 * Annotate only metadata, never spread native entries that might contain secrets.
 * `ambiguous` describes multiple candidate websites; it is a hint, not a refusal.
 * Only an authenticated secret reply can establish that the passwords differ.
 * @param {unknown} host
 * @param {LoginSiteMetadata[]} logins
 */
export function describeLoginCandidatesForHost(host, logins) {
  const target = normalizedHostname(host);
  return logins.map((login) => {
    const sites = [...loginSiteHosts(login)];
    const exact = !!target && sites.includes(target);
    const username = typeof login.username === 'string' ? login.username : '';
    const peers = logins.filter((item) => (item.username || '') === username);
    const exactPeers = peers.filter((item) => loginExactlyMatchesHost(host, item));
    const pool = exactPeers.length ? exactPeers : peers;
    const sources = new Set(pool.map((item) => [...loginSiteHosts(item)].sort().join('\n')));
    return {
      username,
      sites,
      sourceWebsite: exact ? target || '' : sites[0] || '',
      match: exact ? 'exact' : sites.length ? 'related' : 'unknown',
      ambiguous: sources.size > 1,
    };
  });
}

/**
 * Caller has already limited candidates to one exact username. Prefer the trusted
 * native reply's exact website. Identical secrets are harmless aliases; distinct
 * secrets are ambiguous even when the helper returns them in a consistent order.
 * @template {LoginSiteMetadata} T
 * @param {unknown} host
 * @param {T[]} entries
 * @param {(entry: T) => unknown} valueOf
 * @returns {T | undefined}
 */
export function selectUniqueSecretForHost(host, entries, valueOf) {
  const candidates = entries.filter((entry) => {
    const value = valueOf(entry);
    return typeof value === 'string' ? value.length > 0 : typeof value === 'number' && Number.isFinite(value);
  });
  const exact = candidates.filter((entry) => loginExactlyMatchesHost(host, entry));
  const pool = exact.length ? exact : candidates;
  if (!pool.length) return undefined;
  const first = String(valueOf(pool[0]));
  if (pool.some((entry) => String(valueOf(entry)) !== first)) {
    const error = Object.assign(new Error('Multiple saved items match this account. Review the items in Apple Passwords before filling.'), {
      code: 'ambiguous_account', reason: 'ambiguous_account',
    });
    throw error;
  }
  return pool[0];
}

/** @template {LoginSiteMetadata} T @param {unknown} host @param {T[]} logins @param {string[]} recentUsernames */
export function orderLoginsForHost(host, logins, recentUsernames = []) {
  const recent = recentUsernames;
  /** @param {T} login */
  const mruRank = (login) => {
    const index = recent.indexOf(login?.username || '');
    return index === -1 ? Infinity : index;
  };

  return (logins || [])
    .map((login, index) => ({
      login,
      index,
      exact: loginExactlyMatchesHost(host, login),
    }))
    .sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      const recentDifference = mruRank(a.login) - mruRank(b.login);
      return Number.isNaN(recentDifference) || recentDifference === 0
        ? a.index - b.index
        : recentDifference;
    })
    .map(({ login }) => login);
}
