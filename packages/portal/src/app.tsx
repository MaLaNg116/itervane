import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Alert, Button, ConfigProvider, Result, Select } from 'antd';
import enUS from 'antd/locale/en_US.js';
import zhCN from 'antd/locale/zh_CN.js';
import { meDtoSchema, portalConfigSchema, type Locale, type PortalConfig } from '@itervane/contracts';
import { BrowserSession } from './auth.js';
import { ApiFailure, PortalApi } from './api.js';
import { initialLocale, saveLocale, ui } from './messages.js';
import { PortalContext } from './context.js';
import { Failure, Loading } from './components.js';
import { readRoute } from './router.js';

const ProjectsPage = lazy(async () => ({ default: (await import('./pages/projects.js')).ProjectsPage }));
const ProjectPage = lazy(async () => ({ default: (await import('./pages/project.js')).ProjectPage }));
const TaskPage = lazy(async () => ({ default: (await import('./pages/task.js')).TaskPage }));
const PreauditPage = lazy(async () => ({ default: (await import('./pages/preaudit.js')).PreauditPage }));
const PreauditReportPage = lazy(async () => ({ default: (await import('./pages/preaudit-report.js')).PreauditReportPage }));

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
  return <ConfigProvider locale={locale === 'zh-CN' ? zhCN : enUS} csp={{ nonce }} theme={{ token: { colorPrimary: '#16665a', borderRadius: 10, fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif' } }}>
    <QueryClientProvider client={queries}>
      <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); const main = document.getElementById('main'); if (main) { main.tabIndex = -1; main.focus(); } }}>{t('skip')}</a>
      <header className="topbar"><a href="#/projects" className="brand" aria-label="Itervane"><span className="brand-mark" aria-hidden="true">i</span>Itervane</a>
        <div className="topbar-end"><span className="workspace-label">{t('workspace')}</span><Select aria-label={t('language')} virtual={false} value={locale} onChange={setLocale} options={[{ value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]} /></div>
      </header>
      {!config ? <main id="main" className="login-main">{configError ? <Failure error={new ApiFailure('networkError')} locale={locale} retry={() => setRetry(retry + 1)} /> : <Loading locale={locale} />}</main>
        : !config.enabled ? <main id="main" className="login-main"><Result status="info" title={t('loginDisabled')} subTitle={t('loginDisabledHelp')} /></main>
        : <SessionGate config={config} locale={locale} />}
    </QueryClientProvider>
  </ConfigProvider>;
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
    {snapshot.message && <Alert showIcon className="section-gap" type={snapshot.message === 'signedOut' ? 'success' : 'warning'} title={t(snapshot.message)} />}
    <Button type="primary" size="large" loading={snapshot.status === 'redirecting'} onClick={() => { void session.login(locale); }}>{t('signIn')}</Button>
    <p className="muted login-hint">{t('loginHint')}</p>
  </section></main>;
  return <AuthorizedWorkspace api={api} session={session} epoch={snapshot.epoch} name={snapshot.name ?? snapshot.subject ?? ''} locale={locale} />;
}

function AuthorizedWorkspace({ api, session, epoch, name, locale }: { api: PortalApi; session: BrowserSession; epoch: number; name: string; locale: Locale }) {
  const me = useQuery({ queryKey: [epoch, '/v1/me'], queryFn: ({ signal }) => api.request('/v1/me', meDtoSchema, locale, { signal }), retry: false });
  const hash = useSyncExternalStore(subscribeRoute, routeSnapshot); const route = readRoute(hash);
  const t = (key: Parameters<typeof ui>[1]) => ui(locale, key);
  if (me.isPending) return <main id="main"><Loading locale={locale} /></main>;
  if (me.error) return <main id="main" className="login-main">
    {me.error instanceof ApiFailure && me.error.code === 'forbidden' ? <Result status="403" title={t('accessDenied')} subTitle={t('accessDeniedHelp')} /> : <Failure error={me.error} locale={locale} retry={() => { void me.refetch(); }} />}
    <Button onClick={() => { void session.logout(); }}>{t('signOut')}</Button>
  </main>;
  return <PortalContext value={{ api, session, epoch, locale, me: me.data }}>
    <div className="workspace-layout"><aside className="sidebar"><p className="eyebrow">{t('appTitle')}</p><nav aria-label={t('projects')}><a href="#/projects" aria-current={route.page === 'projects' ? 'page' : undefined}>{t('projects')} <span aria-hidden="true">↗</span></a></nav>
      <div className="account"><span className="account-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><div><strong>{name}</strong><span className="muted">{t(me.data.isWorkspaceOwner ? 'owner' : 'account')}</span></div></div>
      <Button block onClick={() => { void session.logout(); }}>{t('signOut')}</Button>
    </aside><main id="main" className="workspace-main">
      <Suspense fallback={<Loading locale={locale} />}>{route.page === 'projects' ? <ProjectsPage /> : route.page === 'project' ? <ProjectPage key={route.id} id={route.id} />
        : route.page === 'task' ? <TaskPage key={route.id} id={route.id} /> : route.page === 'preaudit' ? <PreauditPage key={route.id} id={route.id} />
          : route.page === 'preaudit-report' ? <PreauditReportPage key={route.id} id={route.id} /> : <Result status="404" title={t('notFound')} extra={<a href="#/projects">{t('backProjects')}</a>} />}</Suspense>
    </main></div>
  </PortalContext>;
}
