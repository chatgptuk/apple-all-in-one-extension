import { safeNativeEvent } from './protocol.js';

const STORAGE_KEY = 'passwordNativeDiagnosticHistory';
const LIMIT = 40;

function safeEvent(event) {
  if (event?.reason === 'worker_started' && Number.isFinite(event.at) && event.at >= 0)
    return { reason: 'worker_started', at: event.at };
  return safeNativeEvent(event);
}

// Keep only allowlisted lifecycle reasons/timestamps/command numbers in browser
// session memory. Worker restart must not erase the very evidence of a lost SRP
// session. This never restores authentication or stores keys, codes or payloads.
export function createNativeDiagnosticJournal(storage) {
  let events = [];
  let pending = Promise.resolve().then(async () => {
    try {
      const stored = (await storage?.get(STORAGE_KEY))?.[STORAGE_KEY];
      if (Array.isArray(stored)) events = stored.slice(-LIMIT).map(safeEvent).filter(Boolean);
    } catch (_) { /* Diagnostics must not block password operations. */ }
  });
  const record = (input) => {
    const event = safeEvent(input);
    if (!event) return;
    pending = pending.then(async () => {
      events = [...events, event].slice(-LIMIT);
      try { await storage?.set({ [STORAGE_KEY]: events.map((entry) => ({ ...entry })) }); }
      catch (_) { /* Retain the in-memory report if browser storage is unavailable. */ }
    });
  };
  record({ reason: 'worker_started', at: Date.now() });
  return {
    record,
    async read() { await pending; return events.map((event) => ({ ...event })); },
  };
}
