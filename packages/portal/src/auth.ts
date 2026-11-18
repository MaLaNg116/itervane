import { InMemoryWebStorage, UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import type { Locale, PortalConfig } from '@itervane/contracts';
import { safeReturnHash } from './router.js';
import type { UiKey } from './messages.js';

export class SessionLost extends Error { constructor() { super('session_expired'); } }
type Snapshot = Readonly<{ status: 'loading' | 'anonymous' | 'authenticated' | 'redirecting'; epoch: number; name?: string; subject?: string; message?: UiKey }>;

export class BrowserSession {
  private readonly manager: UserManager;
  private user: User | null = null;
  private snapshot: Snapshot = { status: 'loading', epoch: 0 };
  private readonly listeners = new Set<() => void>();
  private initialization: Promise<void> | undefined;
  private renewal: Promise<User | null> | undefined;

  constructor(config: Extract<PortalConfig, { enabled: true }>, private readonly clearPrivateData: () => void) {
    this.manager = new UserManager({ authority: config.authority, client_id: config.clientId, response_type: 'code', scope: 'openid',
      redirect_uri: config.redirectUri, post_logout_redirect_uri: config.postLogoutRedirectUri,
      userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
      stateStore: new WebStorageStateStore({ store: sessionStorage, prefix: 'itervane.oidc.' }),
      disablePKCE: false, automaticSilentRenew: false, monitorSession: false, loadUserInfo: false,
      requestTimeoutInSeconds: 10, staleStateAgeInSeconds: 300, maxSilentRenewTimeoutRetries: 0,
    });
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private emit(value: Snapshot) { this.snapshot = Object.freeze(value); for (const listener of this.listeners) listener(); }
  private accept(user: User, epoch: number) {
    if (this.snapshot.epoch !== epoch) return;
    this.user = user;
    const name = typeof user.profile.preferred_username === 'string' ? user.profile.preferred_username.slice(0, 120) : user.profile.sub;
    this.emit({ status: 'authenticated', epoch, name, subject: user.profile.sub });
  }

  initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce(); return this.initialization;
  }
  private async initializeOnce() {
    try {
      if (location.pathname === '/auth/callback') {
        const callback = location.href; history.replaceState(null, '', '/');
        const user = await this.manager.signinRedirectCallback(callback);
        const state = user.state as { returnTo?: unknown } | undefined;
        history.replaceState(null, '', `/${safeReturnHash(state?.returnTo)}`);
        this.accept(user, this.snapshot.epoch);
      } else if (location.pathname === '/auth/logout-callback') {
        const callback = location.href; history.replaceState(null, '', '/');
        await this.manager.signoutRedirectCallback(callback); this.invalidate('signedOut');
      } else this.emit({ status: 'anonymous', epoch: this.snapshot.epoch });
      await this.manager.clearStaleState();
    } catch { this.invalidate('callbackError'); }
  }

  async login(locale: Locale) {
    if (this.snapshot.status === 'redirecting') return;
    this.emit({ status: 'redirecting', epoch: this.snapshot.epoch });
    try { await this.manager.signinRedirect({ state: { returnTo: safeReturnHash(location.hash) }, ui_locales: locale }); }
    catch { this.invalidate('authError'); }
  }
  invalidate(message: UiKey = 'sessionExpired') {
    this.user = null; this.renewal = undefined; this.clearPrivateData();
    this.emit({ status: 'anonymous', epoch: this.snapshot.epoch + 1, message });
    void this.manager.removeUser().catch(() => {});
  }
  async logout() {
    const hint = this.user?.id_token;
    this.user = null; this.clearPrivateData();
    this.emit({ status: 'redirecting', epoch: this.snapshot.epoch + 1 });
    try { await this.manager.signoutRedirect(hint ? { id_token_hint: hint } : {}); }
    catch { this.invalidate('logoutError'); }
  }
  async token(): Promise<{ token: string; epoch: number }> {
    const epoch = this.snapshot.epoch;
    if (!this.user || this.snapshot.status !== 'authenticated') throw new SessionLost();
    if ((this.user.expires_in ?? 0) < 30) {
      if (!this.user.refresh_token) { this.invalidate(); throw new SessionLost(); }
      this.renewal ??= this.manager.signinSilent().finally(() => { this.renewal = undefined; });
      try {
        const user = await this.renewal;
        if (!user || epoch !== this.snapshot.epoch || user.profile.sub !== this.user?.profile.sub) throw new SessionLost();
        this.accept(user, epoch);
      } catch { if (epoch === this.snapshot.epoch) this.invalidate(); throw new SessionLost(); }
    }
    if (!this.user || epoch !== this.snapshot.epoch) throw new SessionLost();
    return { token: this.user.access_token, epoch };
  }
  rejectToken(token: string) { if (this.user?.access_token === token) this.invalidate(); }
}
