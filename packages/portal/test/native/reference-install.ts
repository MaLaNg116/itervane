import { equal, ok } from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv, promisify } from 'node:util';
import { chromium, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { sourceInspectionDtoSchema, taskDtoSchema } from '@itervane/contracts';

const execute = promisify(execFile);
const entry = 'packages/control-plane/src/entries/reference.ts';
const host = '127.0.0.1';
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

async function tokenForMcp(page: Page, install: { issuer: string; mcpClientId: string; mcpRedirectUri: string }) {
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
      scope: 'openid itervane:read', state, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await until(async () => Boolean(code));
    phase = 'mcp_token';
    const response = await fetch(`${install.issuer}/protocol/openid-connect/token`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      body: new URLSearchParams({ client_id: install.mcpClientId, redirect_uri: redirect.href, grant_type: 'authorization_code',
        code: code!, code_verifier: verifier }),
    });
    equal(response.status, 200);
    const { access_token: token } = await response.json() as { access_token: string };
    ok(typeof token === 'string' && token.length > 0);
    return token;
  } finally { await close(server); }
}

async function queueDemo(page: Page) {
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Reference install');
  await page.getByLabel('Project slug', { exact: true }).fill('reference-install');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project', exact: true }).click();
  await page.getByRole('button', { name: 'Register repository', exact: true }).click();
  await page.getByLabel('Repository name', { exact: true }).fill('Reference source');
  await page.getByLabel('HTTPS repository URL', { exact: true }).fill('https://example.invalid/reference-install.git');
  await page.getByRole('button', { name: 'Save repository', exact: true }).click();
  await page.getByRole('button', { name: 'Start preflight', exact: true }).click();
  await page.getByLabel('Full Git commit', { exact: true }).fill('a'.repeat(40));
  await page.getByLabel('Task goal', { exact: true }).fill('Verify fixed-source intake');
  await page.getByRole('button', { name: 'Queue task', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task details', exact: true })).toBeVisible();
  await expect(page.getByText('Task is waiting for a verified Runner.', { exact: true })).toBeVisible({ timeout: 20_000 });
  const taskId = page.url().split('/').at(-1)!;
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('heading', { name: '任务详情', exact: true })).toBeVisible();
  await expect(page.getByText('任务正在等待经过验证的 Runner。', { exact: true })).toBeVisible();
  return taskId;
}

const temp = await mkdtemp(join(tmpdir(), 'itervane-reference-test-'));
const directory = join(temp, 'installation');
let compose: string[] | undefined;
let api: ReturnType<typeof serve> | undefined;
let worker: ReturnType<typeof serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let loginPage: Page | undefined;
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
  api = serve(directory, 'api'); worker = serve(directory, 'worker');
  await until(async () => {
    if (api!.exited || worker!.exited) throw new Error('child exited');
    try { return (await fetch(install.portal + '/health/live', { signal: AbortSignal.timeout(1_000) })).ok; }
    catch { return false; }
  });
  equal((await fetch(install.portal + '/v1/me')).status, 401);

  phase = 'browser_launch';
  const login = parseEnv(await readFile(join(directory, 'owner-login.env'), 'utf8'));
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'reduce' });
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
  const taskId = await queueDemo(page);
  phase = 'mcp_authorization';
  const authPage = await context.newPage();
  loginPage = authPage;
  const token = await tokenForMcp(authPage, install);
  phase = 'mcp_resource_binding';
  equal((await fetch(install.portal + '/v1/me', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const client = new Client({ name: 'reference-install', version: '0.0.0' });
  try {
    phase = 'mcp_connect';
    await client.connect(new StreamableHTTPClientTransport(new URL(install.mcp), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    phase = 'mcp_read_scopes';
    const { tools } = await client.listTools();
    ok(tools.some(tool => tool.name === 'get_task') && !tools.some(tool => tool.name === 'start_audit'));
    phase = 'mcp_read_task';
    const task = taskDtoSchema.parse((await client.callTool({ name: 'get_task', arguments: { taskId } })).structuredContent);
    equal(task.id, taskId); equal(task.state, 'waiting_input');
    const inspection = sourceInspectionDtoSchema.parse((await client.callTool({ name: 'get_source_inspection', arguments: { taskId } })).structuredContent);
    equal(inspection.status, 'blocked'); equal(inspection.sourceFetched, false);
  } finally { await client.close(); }
  console.log(JSON.stringify({ cleanInstallation: true, isolatedRuntimeConfiguration: true, initializedTwice: true,
    keycloak: '26.8.2', postgresMajor: 17, browserPkce: true, ownerPasswordChanged: true, locales: ['en', 'zh-CN'],
    externalMcpPkce: true, mcpScopeAndAudienceVerified: true, taskHeldForRunner: true }));
} catch {
  const loginView = loginPage && await loginPage.evaluate(() => ({
    signIn: Boolean(document.getElementById('kc-login')), passwordUpdate: Boolean(document.getElementById('password-new')),
    keycloakError: Boolean(document.getElementById('kc-error-message')), callbackPath: location.pathname === '/auth/callback',
    portalLanguageSelector: Boolean(document.querySelector('select[aria-label="Language"],select[aria-label="显示语言"]')),
  })).catch(() => undefined);
  console.error(JSON.stringify({ error: 'reference_probe_failed', phase, loginView }));
  process.exitCode = 1;
} finally {
  try { await Promise.all([browser?.close(), api?.close(), worker?.close()]); }
  finally {
    if (compose) await execute('docker', [...compose, 'down', '--volumes'], { env: composeEnv, timeout: 50_000 })
      .catch(() => { console.error('Reference fixture cleanup failed'); process.exitCode = 1; });
    await rm(temp, { recursive: true, force: true });
  }
}
