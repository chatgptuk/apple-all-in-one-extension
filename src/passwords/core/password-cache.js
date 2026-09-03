function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .toLowerCase();
}

export function createPasswordCache({ idleTtlMs, maxTtlMs, now = Date.now }) {
  const entries = new Map();

  const keyFor = (host, username) =>
    `${normalizeHost(host)}\n${normalizeUsername(username)}`;

  return {
    get(host, username) {
      const key = keyFor(host, username);
      const hit = entries.get(key);
      if (!hit) return null;

      const currentTime = now();
      const idleExpired = currentTime - hit.lastUsedAt > idleTtlMs;
      const maximumAgeReached = currentTime - hit.cachedAt > maxTtlMs;
      if (idleExpired || maximumAgeReached) {
        entries.delete(key);
        return null;
      }

      hit.lastUsedAt = currentTime;
      return hit.credential;
    },

    set(host, credential) {
      if (!host || !credential?.username) return;
      const currentTime = now();
      entries.set(keyFor(host, credential.username), {
        credential,
        cachedAt: currentTime,
        lastUsedAt: currentTime,
      });
    },

    clear() {
      entries.clear();
    },
  };
}
