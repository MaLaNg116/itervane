import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv, promisify } from 'node:util';
import { chromium, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { codeRuleValidationProfileSchema, formalAuditDtoSchema, projectDtoSchema, repositoryDtoSchema, sourceInspectionDtoSchema,
  standardVerificationProfileSchema, taskDtoSchema, type CodeRuleValidationProfile, type StandardVerificationProfile } from '@itervane/contracts';
import { auditFixtureKey, auditFixtureModel, auditProtocolFixture } from '../../../control-plane/test/native/audit-provider.js';
import { sourceWorkerEnvironment, startScopedWorker } from '../../../control-plane/test/native/scoped-worker.js';
import { npmReleaseApproval } from '../../../verification/src/native/npm-release-fixture.js';
import { proveReferenceDevelopment } from './reference-release.js';

const execute = promisify(execFile);
const entry = 'packages/control-plane/src/entries/reference.ts';
const host = '127.0.0.1';
const referenceSource = 'https://github.com/MaLaNg116/itervane.git';
const referenceRevision = '49799e18f4f63cf22767a9cd8054cab979b9b6d2';
const args = process.argv.slice(2);
const [mode, workerBundle] = args;
const runbookMode = mode === '--native-runbook';
const operationsMode = mode === '--native-operations' || runbookMode;
const codeRuleMode = mode === '--native-code-rule';
const restoreMode = mode === '--native-version-restore';
const releaseMode = mode === '--native-release' || operationsMode || codeRuleMode || restoreMode;
if (args.length && (args.length !== 2 || (!releaseMode && mode !== '--native-runner') || process.platform !== 'linux'
  || process.env.PROBE_HOST_ENVIRONMENT !== 'github-hosted'
  || !workerBundle || !/^\/var\/lib\/libvirt\/images\/itervane-native\.[a-zA-Z0-9]{8}\/qualified\/worker\.mjs$/.test(workerBundle))) {
  throw new Error('reference_native_runner_config');
}
let phase = 'allocate_ports';
const close = (server: Server) => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));

async function availablePorts() {
  const servers = Array.from({ length: 4 }, () => createServer());
  const ports = await Promise.all(servers.map(server => new Promise<number>((done, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address && typeof address !== 'string') done(address.port);
      else reject(new Error('no port'));
    });
  })));
  await Promise.all(servers.map(close));
  return ports;
}

async function until(fn: () => Promise<boolean>, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(200);
  }
  throw new Error('readiness timeout');
}

function serve(directory: string, role: 'api' | 'worker') {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, 'start', directory, role], {
    stdio: 'ignore', env: { ...process.env, DATABASE_URL: 'postgresql://wrong@127.0.0.1:1/ignored', ITERVANE_API_HOST: '0.0.0.0' },
  });
  let exited = false;
  const stopped = new Promise<void>(done => {
    const end = () => { exited = true; done(); };
    child.once('close', end); child.once('error', end);
  });
  return { get exited() { return exited; }, async close() {
    if (!exited) child.kill('SIGTERM');
    await stopped;
  } };
}

async function tokenForMcp(page: Page, install: { issuer: string; mcpClientId: string; mcpRedirectUri: string }, write: boolean) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(20).toString('hex');
  const redirect = new URL(install.mcpRedirectUri);
  let code: string | undefined;
  const server = createHttp((request, response) => {
    const url = new URL(request.url ?? '/', redirect.origin);
    const accepted = url.pathname === redirect.pathname && url.searchParams.get('state') === state && url.searchParams.get('code');
    if (accepted) code = accepted;
    response.writeHead(accepted ? 200 : 400, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(accepted ? 'Connected' : 'Rejected');
  });
  server.on('error', () => {});
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(Number(redirect.port), host, done); });
  try {
    phase = 'mcp_callback';
    const url = new URL(`${install.issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({ client_id: install.mcpClientId, redirect_uri: redirect.href, response_type: 'code',
      scope: write ? 'openid itervane:read itervane:write' : 'openid itervane:read', state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await until(async () => Boolean(code));
    phase = 'mcp_token';
    const exchange = async (parameters: Record<string, string>) => {
      const response = await fetch(`${install.issuer}/protocol/openid-connect/token`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
        body: new URLSearchParams({ client_id: install.mcpClientId, ...parameters }),
      });
      equal(response.status, 200);
      const { access_token: token, refresh_token: refreshToken, expires_in: expiresIn } = await response.json() as
        { access_token: string; refresh_token: string; expires_in: number };
      ok(token && refreshToken && Number.isInteger(expiresIn) && expiresIn > 30);
      return { token, refreshToken, renewAt: Date.now() + (expiresIn - 30) * 1_000 };
    };
    let current = await exchange({ grant_type: 'authorization_code', redirect_uri: redirect.href, code: code!, code_verifier: verifier });
    let renewing: Promise<typeof current> | undefined;
    return async () => {
      if (Date.now() >= current.renewAt) {
        renewing ??= exchange({ grant_type: 'refresh_token', refresh_token: current.refreshToken }).finally(() => { renewing = undefined; });
        current = await renewing;
      }
      return current.token;
    };
  } finally { await close(server); }
}

async function prepareProject(page: Page, useRunner: boolean) {
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Reference install');
  await page.getByLabel('Project slug', { exact: true }).fill('reference-install');
  const projectResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/projects'
    && response.request().method() === 'POST' && response.status() === 201);
  await page.getByRole('dialog').getByRole('button', { name: 'Create project', exact: true }).click();
  const project = projectDtoSchema.parse(await (await projectResponse).json());
  await page.getByRole('button', { name: 'Register repository', exact: true }).click();
  await page.getByLabel('Repository name', { exact: true }).fill('Reference source');
  await page.getByLabel('HTTPS repository URL', { exact: true }).fill(useRunner ? referenceSource : 'https://example.invalid/reference-install.git');
  const repositoryResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/v1/projects/${project.id}/repositories`
    && response.request().method() === 'POST' && response.status() === 201);
  await page.getByRole('button', { name: 'Save repository', exact: true }).click();
  const repository = repositoryDtoSchema.parse(await (await repositoryResponse).json());
  return { projectId: project.id, repositoryId: repository.id };
}

async function queueDemo(page: Page, useRunner: boolean) {
  await page.getByRole('button', { name: 'Start preflight', exact: true }).click();
  await page.getByLabel('Full Git commit', { exact: true }).fill(useRunner ? referenceRevision : 'a'.repeat(40));
  await page.getByLabel('Task goal', { exact: true }).fill('Verify fixed-source intake');
  await page.getByRole('button', { name: 'Queue task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task details', exact: true })).toBeVisible();
  if (!useRunner) await expect(page.getByText('Task is waiting for a verified Runner.', { exact: true })).toBeVisible({ timeout: 20_000 });
  const taskId = page.url().split('/').at(-1)!;
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '任务详情', exact: true })).toBeVisible();
  if (!useRunner) await expect(page.getByText('任务正在等待经过验证的 Runner。', { exact: true })).toBeVisible();
  return taskId;
}

async function waitForAudit(page: Page, taskId: string) {
  const response = await page.waitForResponse(async observed => {
    if (observed.request().method() !== 'GET' || new URL(observed.url()).pathname !== `/v1/tasks/${taskId}/audit`
      || observed.status() !== 200) return false;
    const audit = formalAuditDtoSchema.safeParse(await observed.json().catch(() => null));
    return audit.success && audit.data.locale === 'zh-CN' && audit.data.status === 'recorded';
  }, { timeout: 190_000 });
  const audit = formalAuditDtoSchema.parse(await response.json());
  ok(audit.status === 'recorded');
  equal(audit.result.status, 'completed');
  equal(audit.result.checklist?.coverage, 'complete');
  ok(audit.result.trace.length > 0);
  return audit;
}

const temp = await mkdtemp(join(tmpdir(), 'itervane-reference-test-'));
const directory = join(temp, 'installation');
let compose: string[] | undefined;
let api: ReturnType<typeof serve> | undefined;
let worker: ReturnType<typeof serve> | undefined;
let nativeWorker: Awaited<ReturnType<typeof startScopedWorker>> | undefined;
let auditProvider: Awaited<ReturnType<typeof auditProtocolFixture>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let loginPage: Page | undefined;
let releaseWorkerSettings: { workerBundle: string; databaseUrl: string; runnerEnvironment: string[];
  verificationProfile: StandardVerificationProfile } | undefined;
let codeProfile: CodeRuleValidationProfile | undefined;
const composeEnv = { ...process.env };
for (const key of ['COMPOSE_PROJECT_NAME', 'ITERVANE_REFERENCE_PG_PORT', 'ITERVANE_REFERENCE_IDP_PORT']) delete composeEnv[key];
try {
  const ports = (await availablePorts()).map(String);
  phase = 'prepare';
  const prepared = await execute(process.execPath, ['--import', 'tsx', entry, 'prepare', directory, ...ports]);
  const { project } = JSON.parse(prepared.stdout) as { project: string };
  ok(/^itervane-reference-[a-f0-9]{16}$/.test(project));
  compose = ['compose', '--project-name', project, '--project-directory', directory, '--env-file', join(directory, '.env'),
    '--file', join(directory, 'compose.yml')];
  phase = 'compose';
  await execute('docker', [...compose, 'config', '--quiet'], { env: composeEnv, timeout: 15_000 });
  await execute('docker', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '120'], { env: composeEnv, timeout: 300_000 });
  phase = 'initialize';
  const setup = await execute(process.execPath, ['--import', 'tsx', entry, 'init', directory], { timeout: 140_000 });
  const install = JSON.parse(setup.stdout) as { portal: string; issuer: string; mcp: string; mcpClientId: string; mcpRedirectUri: string };
  await execute(process.execPath, ['--import', 'tsx', entry, 'init', directory], { timeout: 140_000 });
  phase = 'serve';
  api = serve(directory, 'api');
  if (workerBundle) {
    phase = 'native_worker_connection';
    const { ITERVANE_RUNNER_SOCKET: socket, ITERVANE_RUNNER_UID: uid, ITERVANE_RUNNER_IMAGE_SHA256: image } =
      parseEnv(await readFile('.reports/p0/runner-reference-connection.env', 'utf8'));
    const { DATABASE_URL: databaseUrl } = parseEnv(await readFile(join(directory, 'worker.env'), 'utf8'));
    ok(socket === '/run/itervane-reference-runner/inspection.sock' && uid && /^[1-9][0-9]{0,9}$/.test(uid));
    ok(image && /^[a-f0-9]{64}$/.test(image) && databaseUrl);
    const runnerEnvironment = sourceWorkerEnvironment(socket, uid, image);
    let releaseSettings: string[] = [];
    if (releaseMode) {
      const profiles = parseEnv(await readFile('.reports/p0/runner-reference-profile.env', 'utf8'));
      const verificationProfile = standardVerificationProfileSchema.parse(JSON.parse(profiles.ITERVANE_VERIFICATION_PROFILE ?? 'null'));
      equal(verificationProfile.runnerImageSha256, image);
      releaseWorkerSettings = { workerBundle, databaseUrl, runnerEnvironment, verificationProfile };
      releaseSettings = [`ITERVANE_VERIFICATION_PROFILE=${JSON.stringify(verificationProfile)}`];
      if (codeRuleMode) {
        codeProfile = codeRuleValidationProfileSchema.parse(JSON.parse(profiles.ITERVANE_CODE_RULE_VALIDATION_PROFILE ?? 'null'));
        equal(codeProfile.runnerImageSha256, image);
      } else if (!restoreMode) releaseSettings.push('ITERVANE_FORMAL_REPAIR=1', `ITERVANE_NPM_REPAIR_APPROVALS=${JSON.stringify([npmReleaseApproval])}`);
    }
    auditProvider = await auditProtocolFixture({ dependencyRepair: releaseMode && !codeRuleMode && !restoreMode, linkedHealth: codeRuleMode });
    nativeWorker = await startScopedWorker(workerBundle, [...runnerEnvironment, ...releaseSettings,
      'ITERVANE_WORKER_POLL_MS=100', 'ITERVANE_AUDIT_MODEL_PROVIDER=anthropic',
      `ANTHROPIC_BASE_URL=${auditProvider.baseURL}`, `ANTHROPIC_MODEL=${auditFixtureModel}`],
    { DATABASE_URL: databaseUrl, ANTHROPIC_API_KEY: auditFixtureKey });
  } else worker = serve(directory, 'worker');
  await until(async () => {
    if (api!.exited || worker?.exited) throw new Error('child exited');
    try { return (await fetch(install.portal + '/health/live', { signal: AbortSignal.timeout(1_000) })).ok; }
    catch { return false; }
  });
  equal((await fetch(install.portal + '/v1/me')).status, 401);

  phase = 'browser_launch';
  const login = parseEnv(await readFile(join(directory, 'owner-login.env'), 'utf8'));
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ baseURL: install.portal, locale: 'en-US', reducedMotion: 'reduce' });
  const page = loginPage = await context.newPage();
  page.setDefaultTimeout(15_000);
  phase = 'browser_login';
  await page.goto(install.portal);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  phase = 'keycloak_credentials';
  await page.locator('#username').fill(login.ITERVANE_OWNER_USERNAME!);
  await page.locator('#password').fill(login.ITERVANE_OWNER_INITIAL_PASSWORD!);
  await page.locator('#kc-login').click();
  phase = 'initial_password_form';
  const password = randomBytes(24).toString('hex');
  await page.locator('#password-new').fill(password);
  await page.locator('#password-confirm').fill(password);
  phase = 'initial_password_submit';
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  phase = 'portal_callback';
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 20_000 });

  phase = 'task_intake';
  const resources = await prepareProject(page, Boolean(workerBundle));
  const taskId = releaseMode ? undefined : await queueDemo(page, Boolean(workerBundle));
  phase = 'reference_formal_audit';
  const portalAudit = workerBundle && taskId ? await waitForAudit(page, taskId) : undefined;
  phase = 'mcp_authorization';
  const authPage = await context.newPage();
  loginPage = authPage;
  const mcpToken = await tokenForMcp(authPage, install, releaseMode);
  phase = 'mcp_resource_binding';
  equal((await fetch(install.portal + '/v1/me', { headers: { Authorization: `Bearer ${await mcpToken()}` } })).status, 401);
  const client = new Client({ name: 'reference-install', version: '0.0.0' });
  let verifiedAudit: { taskId: string; auditSha256: string; scanSha256: string; snapshotSha256: string; model: string } | undefined;
  let development: Awaited<ReturnType<typeof proveReferenceDevelopment>> | undefined;
  try {
    phase = 'mcp_connect';
    await client.connect(new StreamableHTTPClientTransport(new URL(install.mcp), { fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${await mcpToken()}`);
      headers.set('Accept-Language', 'en');
      return fetch(input, { ...init, headers, redirect: 'error' });
    } }));
    phase = 'mcp_read_scopes';
    const { tools } = await client.listTools();
    ok(tools.some(tool => tool.name === 'get_task'));
    equal(tools.some(tool => tool.name === 'start_audit'), releaseMode);
    equal(tools.some(tool => tool.name === 'request_release'), releaseMode);
    if (releaseMode) {
      phase = 'reference_development';
      ok(releaseWorkerSettings && auditProvider);
      const configureApi = async (settings: Record<string, string>) => {
        await nativeWorker?.stop('TERM');
        nativeWorker = undefined;
        await api?.close();
        await appendFile(join(directory, 'api.env'), Object.entries(settings).map(([key, value]) => `${key}=${value}\n`).join(''));
        api = serve(directory, 'api');
        await until(async () => {
          if (api!.exited) throw new Error('operations_api_start');
          try { return (await fetch(install.portal + '/health/live', { signal: AbortSignal.timeout(1_000) })).ok; }
          catch { return false; }
        });
      };
      const operations = operationsMode ? { modelUrl: auditProvider.baseURL, runbook: runbookMode, configureApi } : undefined;
      const restore = restoreMode ? { modelUrl: auditProvider.baseURL, configureApi } : undefined;
      if (codeRuleMode) ok(codeProfile);
      const healthRule = codeProfile ? { modelUrl: auditProvider.baseURL, codeProfile, configureApi, sourceUrl: referenceSource } : undefined;
      development = await proveReferenceDevelopment({ directory, origin: install.portal, page, client, mcpToken,
        ...resources, ...releaseWorkerSettings, ...(operations ? { operations } : {}), ...(healthRule ? { healthRule } : {}),
        ...(restore ? { restore } : {}) });
    } else {
      ok(taskId);
      phase = 'mcp_read_task';
      const task = taskDtoSchema.parse((await client.callTool({ name: 'get_task', arguments: { taskId } })).structuredContent);
      equal(task.id, taskId); equal(task.state, 'waiting_input');
      const inspection = sourceInspectionDtoSchema.parse((await client.callTool({ name: 'get_source_inspection', arguments: { taskId } })).structuredContent);
      if (portalAudit) {
        phase = 'mcp_read_formal_audit';
        const audit = formalAuditDtoSchema.parse((await client.callTool({ name: 'get_audit', arguments: { taskId } })).structuredContent);
        ok(inspection.status === 'completed' && inspection.sourceFetched && inspection.scanCompleted && audit.status === 'recorded');
        equal(inspection.requestedSource.commit, referenceRevision);
        equal(inspection.runId, task.runId); equal(audit.runId, task.runId);
        equal(audit.result.inspectionSha256, inspection.result.receiptSha256);
        equal(audit.result.snapshotSha256, inspection.result.snapshotSha256);
        deepStrictEqual(audit.result, portalAudit.result);
        equal(audit.sha256, portalAudit.sha256);
        equal(audit.locale, 'en'); equal(portalAudit.locale, 'zh-CN');
        notEqual(audit.message, portalAudit.message);
        verifiedAudit = { taskId, auditSha256: audit.sha256, scanSha256: inspection.result.receiptSha256,
          snapshotSha256: inspection.result.snapshotSha256, model: 'scripted_anthropic_fixture' };
      } else {
        equal(inspection.status, 'blocked'); equal(inspection.sourceFetched, false);
      }
    }
  } finally { await client.close(); }
  console.log(JSON.stringify({ cleanInstallation: true, isolatedRuntimeConfiguration: true, initializedTwice: true,
    keycloak: '26.8.2', postgresMajor: 17, browserPkce: true, ownerPasswordChanged: true, locales: ['en', 'zh-CN'],
    externalMcpPkce: true, mcpScopeAndAudienceVerified: true,
    ...(development ? { qualifiedRunner: true, development }
      : verifiedAudit ? { qualifiedRunner: true, audit: verifiedAudit } : { taskHeldForRunner: true }) }));
} catch (error) {
  const loginView = loginPage && await loginPage.evaluate(() => ({
    signIn: Boolean(document.getElementById('kc-login')), passwordUpdate: Boolean(document.getElementById('password-new')),
    keycloakError: Boolean(document.getElementById('kc-error-message')), callbackPath: location.pathname === '/auth/callback',
    portalLanguageSelector: Boolean(document.querySelector('select[aria-label="Language"],select[aria-label="显示语言"]')),
  })).catch(() => undefined);
  const detail = error instanceof Error && /^reference_(?:release|operations|code_rule|restore)_[a-z_]+$/.test(error.message) ? error.message : undefined;
  console.error(JSON.stringify({ error: 'reference_probe_failed', phase, detail, loginView }));
  process.exitCode = 1;
} finally {
  const stopped = await Promise.allSettled([browser?.close(), api?.close(), worker?.close(), nativeWorker?.stop('TERM')]);
  if (stopped.some(result => result.status === 'rejected')) {
    console.error('Reference service cleanup failed');
    process.exitCode = 1;
  }
  try { await auditProvider?.close(); }
  finally {
    if (compose) await execute('docker', [...compose, 'down', '--volumes'], { env: composeEnv, timeout: 50_000 })
      .catch(() => { console.error('Reference fixture cleanup failed'); process.exitCode = 1; });
    await rm(temp, { recursive: true, force: true });
  }
}
