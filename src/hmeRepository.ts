import ICloudClient, {
  PremiumMailSettings,
  UnsuccessfulRequestError,
  type HmeEmail,
  type ListHmeResult,
} from './iCloudClient';

export const HME_LIST_CACHE_TTL = 2 * 60 * 1000;
export const HME_LIST_SESSION_CACHE_KEY = 'hmeListSessionCacheV2';
export type HmeListSnapshot = {
  emails: HmeEmail[];
  forwardTo: string;
  forwardToEmails: string[];
  fetchedAt: number;
};
export const hmeListCacheKey = (
  client: Pick<ICloudClient, 'setupUrl' | 'dsid'>
) => `${client.setupUrl}\n${client.dsid || ''}`;
export type HmeOperation =
  | 'snapshot'
  | 'list'
  | 'generate'
  | 'reserve'
  | 'metadata'
  | 'deactivate'
  | 'reactivate'
  | 'delete'
  | 'forward'
  | 'invalidate';
type Persistence = {
  read: (key: string) => Promise<HmeListSnapshot | undefined>;
  write: (key: string, snapshot?: HmeListSnapshot) => Promise<void>;
  changed: (key: string) => void;
};

/** The background is the single owner. Serializing reads/mutations per account
 * also prevents an old list response from resurrecting a deleted address. */
export class HmeRepository {
  private snapshots = new Map<string, HmeListSnapshot>();
  private queues = new Map<string, Promise<unknown>>();
  private epochs = new Map<string, number>();
  private cooldowns = new Map<
    string,
    { until: number; error: UnsuccessfulRequestError }
  >();
  constructor(
    private persistence: Persistence,
    private now = Date.now
  ) {}

  private async snapshot(key: string) {
    if (this.snapshots.has(key)) return this.snapshots.get(key);
    const epoch = this.epochs.get(key) || 0;
    const saved = await this.persistence.read(key);
    if ((this.epochs.get(key) || 0) !== epoch) return undefined;
    if (saved) this.snapshots.set(key, saved);
    return saved;
  }

  async invalidate(key: string) {
    this.epochs.set(key, (this.epochs.get(key) || 0) + 1);
    this.snapshots.delete(key);
    this.cooldowns.delete(key);
    await this.persistence.write(key);
    this.persistence.changed(key);
  }

  execute(
    client: ICloudClient,
    operation: HmeOperation,
    args: unknown[] = []
  ): Promise<unknown> {
    const key = hmeListCacheKey(client);
    const epoch = this.epochs.get(key) || 0;
    const run = async () => {
      if ((this.epochs.get(key) || 0) !== epoch)
        throw new Error('iCloud session changed. Retry the operation.');
      if (operation === 'invalidate') return this.invalidate(key);
      const snapshot = await this.snapshot(key);
      if (operation === 'snapshot') return snapshot;
      const force = args[0] === true;
      const asList = (s: HmeListSnapshot): ListHmeResult => ({
        hmeEmails: s.emails,
        selectedForwardTo: s.forwardTo,
        forwardToEmails: s.forwardToEmails,
      });
      if (
        operation === 'list' &&
        snapshot &&
        !force &&
        this.now() - snapshot.fetchedAt < HME_LIST_CACHE_TTL
      )
        return asList(snapshot);
      const cooldown = this.cooldowns.get(key);
      if (cooldown && cooldown.until > this.now()) throw cooldown.error;
      const api = new PremiumMailSettings(client);
      let next = snapshot;
      let result: unknown;
      const id = String(args[0] || '');
      const patch = (fields: Partial<HmeEmail>) =>
        snapshot
          ? {
              ...snapshot,
              emails: snapshot.emails.map((email) =>
                email.anonymousId === id ? { ...email, ...fields } : email
              ),
            }
          : undefined;
      try {
        switch (operation) {
          case 'list': {
            const response = await api.listHme();
            if (!Array.isArray(response?.hmeEmails))
              throw new Error('Invalid iCloud address-list response');
            next = {
              emails: response.hmeEmails,
              forwardTo: response.selectedForwardTo,
              forwardToEmails: response.forwardToEmails || [],
              fetchedAt: this.now(),
            };
            result = response;
            break;
          }
          case 'generate':
            return await api.generateHme();
          case 'reserve': {
            const email = await api.reserveHme(
              id,
              String(args[1] || ''),
              args[2] === undefined ? undefined : String(args[2])
            );
            if (snapshot && email?.anonymousId)
              next = {
                ...snapshot,
                emails: [
                  email,
                  ...snapshot.emails.filter(
                    (item) => item.anonymousId !== email.anonymousId
                  ),
                ],
              };
            else next = undefined;
            result = email;
            break;
          }
          case 'metadata':
            await api.updateHmeMetadata(
              id,
              String(args[1] || ''),
              String(args[2] || '')
            );
            next = patch({
              label: String(args[1] || ''),
              note: String(args[2] || ''),
            });
            break;
          case 'deactivate':
            await api.deactivateHme(id);
            next = patch({ isActive: false });
            break;
          case 'reactivate':
            await api.reactivateHme(id);
            next = patch({ isActive: true });
            break;
          case 'delete':
            await api.deleteHme(id);
            next = snapshot
              ? {
                  ...snapshot,
                  emails: snapshot.emails.filter(
                    (email) => email.anonymousId !== id
                  ),
                }
              : undefined;
            break;
          case 'forward':
            await api.updateForwardToHme(id);
            next = snapshot
              ? {
                  ...snapshot,
                  forwardTo: id,
                  emails: snapshot.emails.map((email) => ({
                    ...email,
                    forwardToEmail: id,
                  })),
                }
              : undefined;
            break;
          default:
            throw new Error('Unsupported Hide My Email operation');
        }
      } catch (error) {
        if (error instanceof UnsuccessfulRequestError && error.status === 429)
          this.cooldowns.set(key, {
            until: this.now() + (error.retryAfterMs || 30_000),
            error,
          });
        throw error;
      }
      if ((this.epochs.get(key) || 0) !== epoch)
        throw new Error(
          'iCloud session changed. Reopen My Addresses to check the result.'
        );
      if (next) this.snapshots.set(key, next);
      else this.snapshots.delete(key);
      // A successful server mutation stays successful even when session storage
      // is temporarily unavailable. Memory is still authoritative in this worker.
      await this.persistence.write(key, next).catch(() => {});
      this.persistence.changed(key);
      return result;
    };
    const task = (this.queues.get(key) || Promise.resolve()).then(run, run);
    this.queues.set(key, task);
    const cleanup = () => {
      if (this.queues.get(key) === task) this.queues.delete(key);
    };
    task.then(cleanup, cleanup);
    return task;
  }
}
