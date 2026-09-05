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
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

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

export function loginExactlyMatchesHost(host, login) {
  const target = normalizedHostname(host);
  if (!target) return false;
  const sites = new Set();
  collectSiteHostnames(login?.sites, sites);
  collectSiteHostnames(login?.highLevelDomain, sites);
  return sites.has(target);
}

export function orderLoginsForHost(host, logins, recentUsernames = []) {
  const recent = recentUsernames;
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
