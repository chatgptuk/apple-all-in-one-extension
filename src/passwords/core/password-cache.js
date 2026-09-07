function normalizeHost(host) {
  return String(host || '')
    .trim()
    .toLowerCase();
}

import { accountKey } from './account-identity.js';

export function createPasswordCache({
  idleTtlMs,
  maxTtlMs,
  maxEntries = 32,
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
}) {
  const entries = new Map();
  const capacity = Math.max(1, Math.floor(maxEntries));
  let timer;

  const keyFor = (host, username) =>
    JSON.stringify([normalizeHost(host), accountKey(username)]);
  const expiresAt = (entry) => Math.min(entry.lastUsedAt + idleTtlMs, entry.cachedAt + maxTtlMs);
  const prune = () => {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (expiresAt(entry) <= currentTime) entries.delete(key);
    }
  };
  const schedule = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (!entries.size) return;
    const nextExpiry = Math.min(...Array.from(entries.values(), expiresAt));
    timer = setTimer(() => {
      timer = undefined;
      prune();
      schedule();
    }, Math.max(1, nextExpiry - now()));
    // Node regression tests should not be kept alive by an otherwise idle cache.
    timer?.unref?.();
  };

  return {
    get(host, username) {
      prune();
      const key = keyFor(host, username);
      const hit = entries.get(key);
      if (!hit) {
        schedule();
        return null;
      }

      hit.lastUsedAt = now();
      // Map order is LRU; only the exact host/account refreshes this entry.
      entries.delete(key);
      entries.set(key, hit);
      schedule();
      return hit.credential;
    },

    set(host, credential) {
      if (!host || !credential?.username) return;
      prune();
      const currentTime = now();
      const key = keyFor(host, credential.username);
      entries.delete(key);
      entries.set(key, {
        credential,
        cachedAt: currentTime,
        lastUsedAt: currentTime,
      });
      while (entries.size > capacity) entries.delete(entries.keys().next().value);
      schedule();
    },

    clear() {
      entries.clear();
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },

    // Only a count is exposed for diagnostics; never enumerate secret values.
    get size() { return entries.size; },
  };
}
