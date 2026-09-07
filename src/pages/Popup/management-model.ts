import type { HmeEmail } from '../../iCloudClient';

export type AddressFilter = 'all' | 'current' | 'active' | 'inactive';
export type AddressSort = 'created' | 'label' | 'activity';
export type ManagerViewState = {
  filter: AddressFilter;
  sort: AddressSort;
  visibleCount: number;
  scrollTop: number;
};
export const ADDRESS_PAGE_SIZE = 50;
export const DEFAULT_MANAGER_VIEW: ManagerViewState = {
  filter: 'all', sort: 'created', visibleCount: ADDRESS_PAGE_SIZE, scrollTop: 0,
};

/** Persist only presentation settings, never the search text or selected addresses. */
export function sanitizeManagerView(value: unknown): ManagerViewState {
  const state = value as Partial<ManagerViewState> | undefined;
  return {
    filter: ['all', 'current', 'active', 'inactive'].includes(state?.filter || '')
      ? state!.filter! : 'all',
    sort: ['created', 'label', 'activity'].includes(state?.sort || '')
      ? state!.sort! : 'created',
    visibleCount: Number.isFinite(state?.visibleCount)
      ? Math.max(ADDRESS_PAGE_SIZE, Math.min(5000, Math.ceil(state!.visibleCount! / ADDRESS_PAGE_SIZE) * ADDRESS_PAGE_SIZE))
      : ADDRESS_PAGE_SIZE,
    scrollTop: Number.isFinite(state?.scrollTop) ? Math.max(0, Math.min(1_000_000, state!.scrollTop!)) : 0,
  };
}

export function selectManagedAddresses<T extends HmeEmail & { lastReceivedAt?: number }>(
  emails: T[],
  options: { search: string; filter: AddressFilter; sort: AddressSort; currentIds?: Set<string> },
): T[] {
  const query = options.search.trim().toLocaleLowerCase();
  return emails.filter((item) => {
    if (options.filter === 'active' && !item.isActive) return false;
    if (options.filter === 'inactive' && item.isActive) return false;
    if (options.filter === 'current' && !options.currentIds?.has(item.anonymousId)) return false;
    return !query || [item.label, item.domain, item.hme, item.note]
      .some((value) => value?.toLocaleLowerCase().includes(query));
  }).sort((left, right) => {
    if (options.sort === 'label') {
      const order = (left.label || left.hme).localeCompare(right.label || right.hme, undefined, { numeric: true, sensitivity: 'base' });
      if (order) return order;
    }
    if (options.sort === 'activity') {
      const order = (right.lastReceivedAt || 0) - (left.lastReceivedAt || 0);
      if (order) return order;
    }
    return right.createTimestamp - left.createTimestamp || left.anonymousId.localeCompare(right.anonymousId);
  });
}
