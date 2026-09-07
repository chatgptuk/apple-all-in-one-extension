import type { HmeEmail } from './iCloudClient';

export type HmeSiteLinks = Record<string, string[]>;
export type HmeSiteMatch = { email: HmeEmail; match: 'exact' | 'linked' | 'related' };

/** Exact host identity: paths/ports are not associations, and www remains distinct. */
export function normalizeHmeHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return undefined;
  const input = value.trim();
  if (/\s|@/.test(input)) return undefined;
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || (!host.includes('.') && host !== 'localhost') || host.length > 253) return undefined;
    return host;
  } catch { return undefined; }
}

export function matchHmeAliases(emails: HmeEmail[], host: string, links: HmeSiteLinks = {}, options: { includeInactive?: boolean } = {}): HmeSiteMatch[] {
  const target = normalizeHmeHost(host);
  if (!target) return [];
  const matches: HmeSiteMatch[] = [];
  for (const email of emails) {
    if (!email.isActive && !options.includeInactive) continue;
    const candidates = [email.domain, email.label, email.note].map(normalizeHmeHost).filter((value): value is string => !!value);
    const linkedHosts = Object.prototype.hasOwnProperty.call(links, email.anonymousId) && Array.isArray(links[email.anonymousId]) ? links[email.anonymousId] : [];
    const linked = linkedHosts.some((value) => normalizeHmeHost(value) === target);
    const exact = candidates.includes(target);
    const related = candidates.some((value) => target.endsWith(`.${value}`) || value.endsWith(`.${target}`));
    if (exact || linked || related) matches.push({ email, match: exact ? 'exact' : linked ? 'linked' : 'related' });
  }
  const rank = { exact: 0, linked: 1, related: 2 };
  return matches.sort((a, b) => rank[a.match] - rank[b.match] || b.email.createTimestamp - a.email.createTimestamp);
}
