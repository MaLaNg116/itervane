import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { meDtoSchema, portalConfigSchema, type Locale, type PortalConfig } from '@itervane/contracts';
import { BrowserSession } from './auth.js';
import { ApiFailure, PortalApi } from './api.js';
import { initialLocale, saveLocale, ui } from './messages.js';
import { PortalContext } from './context.js';
import { Failure, Loading } from './components.js';
import { readRoute } from './router.js';
import { BrandMark } from './brand.js';
import { Alert, AlertTitle } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Card, CardContent } from './ui/card.js';

const ProjectsPage = lazy(async () => ({ default: (await import('./pages/projects.js')).ProjectsPage }));
const ProjectPage = lazy(async () => ({ default: (await import('./pages/project.js')).ProjectPage }));
const TaskPage = lazy(async () => ({ default: (await import('./pages/task.js')).TaskPage }));
const PreauditPage = lazy(async () => ({ default: (await import('./pages/preaudit.js')).PreauditPage }));
const PreauditReportPage = lazy(async () => ({ default: (await import('./pages/preaudit-report.js')).PreauditReportPage }));
const RuleLibraryPage = lazy(async () => ({ default: (await import('./pages/rule-library.js')).RuleLibraryPage }));
const RulePackagePage = lazy(async () => ({ default: (await import('./pages/rule-library.js')).RulePackagePage }));
const RuleImportPage = lazy(async () => ({ default: (await import('./pages/rule-import.js')).RuleImportPage }));

const queries = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 120_000 }, mutations: { retry: false } } });
const subscribeRoute = (listener: () => void) => { window.addEventListener('hashchange', listener); window.addEventListener('popstate', listener); return () => { window.removeEventListener('hashchange', listener); window.removeEventListener('popstate', listener); }; };
const routeSnapshot = () => location.hash;

export function PortalApp() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [config, setConfig] = useState<PortalConfig | null>(null); const [configError, setConfigError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { document.documentElement.lang = locale; saveLocale(locale); }, [locale]);
  useEffect(() => {
    const controller = new AbortController(); setConfigError(false);
    void fetch('/portal-config', { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error(); return portalConfigSchema.parse(await response.json()); })
      .then(value => {
        if (value.enabled && (new URL(value.redirectUri).origin !== location.origin || new URL(value.postLogoutRedirectUri).origin !== location.origin)) throw new Error();
        setConfig(value);
      }).catch(() => { if (!controller.signal.aborted) setConfigError(true); });
    return () => controller.abort();
  }, [retry]);
  const t = (key: Parameters<typeof ui>[1]) => ui(locale, key);
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="itervane-csp-nonce"]')?.content ?? '';
  return <CSPProvider nonce={nonce}>
    <QueryClientProvider client={queries}>
      <div className="portal-root">
      <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); const main = document.getElementById('main'); if (main) { main.tabIndex = -1; main.focus(); } }}>{t('skip')}</a>
      <header className="topbar"><a href="#/projects" className="brand" aria-label="Itervane"><BrandMark />Itervane</a>
        <div className="topbar-end"><span className="workspace-label">{t('workspace')}</span><select className="language-picker" aria-label={t('language')} value={locale} onChange={event => setLocale(event.currentTarget.value === 'zh-CN' ? 'zh-CN' : 'en')}>
          <option value="en">English</option><option value="zh-CN">简体中文</option>
        </select></div>
      </header>
      {!config ? <main id="main" className="login-main">{configError ? <Failure error={new ApiFailure('networkError')} locale={locale} retry={() => setRetry(retry + 1)} /> : <Loading locale={locale} />}</main>
        : !config.enabled ? <main id="main" className="login-main"><PortalNotice title={t('loginDisabled')} description={t('loginDisabledHelp')} /></main>
        : <SessionGate config={config} locale={locale} />}
      </div>
    </QueryClientProvider>
  </CSPProvider>;
}

function PortalNotice({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <Card><CardContent>
    <h1 className="m-0 text-xl font-semibold">{title}</h1>
    {description && <p className="muted">{description}</p>}
    {children}
  </CardContent></Card>;
}

function SessionGate({ config, locale }: { config: Extract<PortalConfig, { enabled: true }>; locale: Locale }) {
  const [session] = useState(() => new BrowserSession(config, () => { void queries.cancelQueries(); queries.clear(); }));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const api = useMemo(() => new PortalApi(session), [session]);
  useEffect(() => { void session.initialize(); }, [session]);
  useEffect(() => { const restore = (event: PageTransitionEvent) => { if (event.persisted) session.invalidate(); }; window.addEventListener('pageshow', restore); return () => window.removeEventListener('pageshow', restore); }, [session]);
  const t = (key: Parameters<typeof ui>[1]) => ui(locale, key);
  if (snapshot.status === 'loading') return <main id="main"><Loading locale={locale} /></main>;
  if (snapshot.status !== 'authenticated') return <main id="main" className="login-main"><section className="login-card">
    <span className="eyebrow">Itervane / {t('appTitle')}</span><h1>{t('welcome')}</h1><p className="login-intro">{t('intro')}</p>
    {snapshot.message && <Alert className="section-gap" variant={snapshot.message === 'signedOut' ? 'success' : 'warning'} role="status">
      <AlertTitle>{t(snapshot.message)}</AlertTitle>
    </Alert>}
    <Button disabled={snapshot.status === 'redirecting'} aria-busy={snapshot.status === 'redirecting'} onClick={() => { void session.login(locale); }}>{t('signIn')}</Button>
    <p className="muted login-hint">{t('loginHint')}</p>
  </section></main>;
  return <AuthorizedWorkspace api={api} session={session} epoch={snapshot.epoch} name={snapshot.name ?? snapshot.subject ?? ''} locale={locale} />;
}

function AuthorizedWorkspace({ api, session, epoch, name, locale }: { api: PortalApi; session: BrowserSession; epoch: number; name: string; locale: Locale }) {
  const hash = useSyncExternalStore(subscribeRoute, routeSnapshot); const route = readRoute(hash);
  const inRuleLibrary = route.page === 'rule-packages' || route.page === 'rule-package' || route.page === 'rule-import';
  const me = useQuery({ queryKey: [epoch, '/v1/me'], queryFn: ({ signal }) => api.request('/v1/me', meDtoSchema, locale, { signal }), retry: false,
    refetchInterval: inRuleLibrary ? 3_000 : false });
  const t = (key: Parameters<typeof ui>[1]) => ui(locale, key);
  if (me.isPending) return <main id="main"><Loading locale={locale} /></main>;
  if (me.error) return <main id="main" className="login-main">
    {me.error instanceof ApiFailure && me.error.code === 'forbidden'
      ? <PortalNotice title={t('accessDenied')} description={t('accessDeniedHelp')} />
      : <Failure error={me.error} locale={locale} retry={() => { void me.refetch(); }} />}
    <Button variant="outline" className="mt-4" onClick={() => { void session.logout(); }}>{t('signOut')}</Button>
  </main>;
  return <PortalContext value={{ api, session, epoch, locale, me: me.data }}>
    <div className="workspace-layout"><aside className="sidebar"><p className="eyebrow">{t('appTitle')}</p><nav aria-label={t('workspace')}><a href="#/projects" aria-current={route.page === 'projects' ? 'page' : undefined}>
      <svg viewBox="0 0 20 20" className="nav-icon" aria-hidden="true" focusable="false"><path d="M3 4h5l2 2h7v10H3Z" /></svg>{t('projects')}</a>
      {me.data.isWorkspaceOwner && <a href="#/rule-packages" aria-current={inRuleLibrary ? 'page' : undefined}>{t('ruleLibrary')}</a>}
    </nav>
      <div className="workspace-note"><strong>{t('workspaceGuide')}</strong><p>{t('workspaceGuideDetail')}</p></div>
      <div className="account"><span className="account-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><div><strong>{name}</strong><span className="muted">{t(me.data.isWorkspaceOwner ? 'owner' : 'account')}</span></div></div>
      <Button variant="outline" className="signout w-full" onClick={() => { void session.logout(); }}>{t('signOut')}</Button>
    </aside><main id="main" className="workspace-main">
      <Suspense fallback={<Loading locale={locale} />}>{route.page === 'projects' ? <ProjectsPage /> : route.page === 'project' ? <ProjectPage key={route.id} id={route.id} />
        : route.page === 'task' ? <TaskPage key={route.id} id={route.id} /> : route.page === 'preaudit' ? <PreauditPage key={route.id} id={route.id} />
          : route.page === 'preaudit-report' ? <PreauditReportPage key={route.id} id={route.id} />
            : inRuleLibrary && !me.data.isWorkspaceOwner ? <PortalNotice title={t('accessDenied')} description={t('accessDeniedHelp')} />
              : route.page === 'rule-packages' ? <RuleLibraryPage />
                : route.page === 'rule-package' ? <RulePackagePage key={route.versionId} packageId={route.packageId} versionId={route.versionId} />
                  : route.page === 'rule-import' ? <RuleImportPage />
                    : <PortalNotice title={t('notFound')}><p><a href="#/projects">{t('backProjects')}</a></p></PortalNotice>}</Suspense>
    </main></div>
  </PortalContext>;
}
