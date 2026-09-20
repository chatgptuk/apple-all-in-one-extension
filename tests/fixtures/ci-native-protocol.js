// CI fixture only. Copied over the protocol adapter in a throwaway extension.
// No native host is contacted and no Apple data is read.
export const State = { Disconnected: 'disconnected', NeedsPin: 'needs_pin', Unlocked: 'unlocked', NoHelper: 'no_helper' };
// The synthetic adapter emits no native lifecycle events. Worker-start markers
// are still supplied by the real diagnostic journal.
export const safeNativeEvent = () => undefined;
globalThis.__CI_NATIVE__ = { reads: 0, delayMs: 0, startedAt: Date.now() };
export class ApplePasswords {
  constructor() { this.state = State.Unlocked; this.ready = true; this.hasChallenge = false; }
  onStateChange(callback) { this.callback = callback; }
  getDiagnostics() { return { startedAt: globalThis.__CI_NATIVE__.startedAt, events: [] }; }
  async connect() { this.ready = true; this.state = State.Unlocked; }
  async getLoginNamesForURL(_tabId, url) { return [{ username: 'synthetic-user', url, urls: [url] }]; }
  async getPasswordForLoginName(_tabId, _url, login) {
    globalThis.__CI_NATIVE__.reads++;
    await new Promise((resolve) => setTimeout(resolve, globalThis.__CI_NATIVE__.delayMs));
    return { username: login.username, password: `ci-only-${login.username}` };
  }
  async listOneTimeCodesForURL() { return []; }
  async getOneTimeCodeForURL() { return []; }
  async saveLogin() { throw new Error('Saving is deliberately unavailable in browser smoke tests'); }
  async requestChallenge() { this.hasChallenge = true; }
  async verifyPin() { this.ready = true; this.state = State.Unlocked; }
  disconnect() { this.ready = false; this.state = State.Disconnected; this.callback?.(this.state); }
}
