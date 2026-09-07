import { accountKey } from './account-identity.js';

const MAX_TTL_MS = 5 * 60_000;

/** Memory-only delayed saves. Expiry removes references, not a JS heap zeroization guarantee. */
export function createPendingSaveQueue({
  ttlMs = MAX_TTL_MS,
  maxEntries = 10,
  now = Date.now,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
  onDiscard = () => {},
} = {}) {
  const ttl = Math.max(1, Math.min(MAX_TTL_MS, ttlMs));
  const capacity = Math.max(1, Math.floor(maxEntries));
  const entries = new Map();
  let sequence = 0;
  let timer;
  const keyFor = (save) => JSON.stringify([String(save.host || '').toLowerCase(), accountKey(save.detected)]);
  const metadata = (entry) => ({
    id: entry.id,
    host: entry.host,
    detected: entry.detected,
    tabId: entry.tabId,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  });
  const discard = (key, reason) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    try { onDiscard(metadata(entry), reason); } catch {}
  };
  const prune = () => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now()) discard(key, 'expired');
    }
  };
  const schedule = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (!entries.size) return;
    const expiry = Math.min(...Array.from(entries.values(), (entry) => entry.expiresAt));
    timer = setTimer(() => { timer = undefined; prune(); schedule(); }, Math.max(1, expiry - now()));
    timer?.unref?.();
  };
  const insert = (save, retry = false) => {
    if (!save?.host || typeof save.password !== 'string' || !save.password) return undefined;
    prune();
    const currentTime = now();
    const createdAt = retry ? save.createdAt : currentTime;
    const expiresAt = retry ? Math.min(save.expiresAt, createdAt + ttl) : currentTime + ttl;
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= currentTime) {
      try { onDiscard(metadata(save), 'expired'); } catch {}
      return undefined;
    }
    const key = keyFor(save);
    const existing = entries.get(key);
    // A failed old attempt must not overwrite a newer password submitted while it ran.
    if (retry && existing && existing.createdAt >= createdAt) return undefined;
    if (existing) discard(key, 'replaced');
    const entry = { ...save, id: retry ? save.id : `save-${++sequence}-${currentTime}`, createdAt, expiresAt };
    entries.set(key, entry);
    while (entries.size > capacity) discard(entries.keys().next().value, 'evicted');
    schedule();
    return metadata(entry);
  };
  return {
    enqueue: (save) => insert(save),
    requeue: (entry) => insert(entry, true),
    takeNext() {
      prune();
      const first = entries.entries().next().value;
      if (!first) return undefined;
      entries.delete(first[0]);
      schedule();
      return first[1];
    },
    takeAll() {
      prune();
      const batch = Array.from(entries.values());
      entries.clear();
      schedule();
      return batch;
    },
    list() { prune(); schedule(); return Array.from(entries.values(), metadata); },
    clear(reason = 'cleared') {
      for (const key of entries.keys()) discard(key, reason);
      schedule();
    },
    get size() { prune(); return entries.size; },
  };
}
