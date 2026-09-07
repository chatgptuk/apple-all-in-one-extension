import { normalizeHmeHost, type HmeSiteLinks } from './hme-site-matching';

export const HME_SITE_LINKS_STORAGE_KEY = 'hmeSiteLinksV1';
type LinkStore = Record<string, HmeSiteLinks>;
type Persistence = { read: () => Promise<unknown>; write: (value: LinkStore) => Promise<void> };

/** These are local website preferences, not credentials. Never share across Apple accounts. */
export class HmeSiteLinkRepository {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private persistence: Persistence) {}

  private validateAccount(key: string) {
    if (!key.split('\n')[1]) throw new Error('Reconnect iCloud before editing website associations.');
  }

  async list(key: string): Promise<HmeSiteLinks> {
    this.validateAccount(key);
    await this.queue;
    const store = await this.persistence.read() as LinkStore | undefined;
    const result: HmeSiteLinks = {};
    for (const [id, hosts] of Object.entries(store?.[key] || {})) {
      if (!Array.isArray(hosts) || ['__proto__', 'constructor', 'prototype'].includes(id)) continue;
      result[id] = [...new Set(hosts.map(normalizeHmeHost).filter((host): host is string => !!host))];
    }
    return result;
  }

  set(key: string, id: string, values: string[]): Promise<string[]> {
    this.validateAccount(key);
    if (typeof id !== 'string' || !id || id.length > 255 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid address identifier.');
    if (!Array.isArray(values) || values.length > 32 || values.some((value) => !normalizeHmeHost(value))) throw new Error('Enter valid website hostnames (up to 32 per address).');
    const hosts = [...new Set(values.map((value) => normalizeHmeHost(value)!))];
    const run = async () => {
      const raw = await this.persistence.read();
      const store: LinkStore = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw as LinkStore } : {};
      const account = { ...store[key] };
      if (hosts.length) account[id] = hosts;
      else delete account[id];
      if (Object.keys(account).length) store[key] = account;
      else delete store[key];
      await this.persistence.write(store);
      return hosts;
    };
    const task = this.queue.then(run, run);
    this.queue = task.then(() => {}, () => {});
    return task;
  }
}
