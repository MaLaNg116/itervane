import { expect, type Page } from '@playwright/test';
import { restartTool, whiskersOrigin } from '../../../verification/src/native/whiskers.js';
import { adminEmail } from './whiskers-fixture.js';

export class NativeBrowserFailure extends Error {
  constructor(
    readonly reason: 'login-form' | 'login-submit' | 'login-rejected' | 'login-navigation' | 'level-control' | 'level-option',
    readonly outcome?: string,
  ) {
    super(reason);
  }
}

export async function signIn(page: Page, password: string) {
  try {
    await page.goto(whiskersOrigin + '/set-culture?culture=en&redirect=/login', { waitUntil: 'domcontentloaded' });
    await page.locator('input[name=email]').fill(adminEmail);
    await page.locator('input[name=password]').fill(password);
  } catch { throw new NativeBrowserFailure('login-form'); }
  let response;
  try {
    [response] = await Promise.all([
      page.waitForResponse(reply => reply.url() === whiskersOrigin + '/login-local' && reply.request().method() === 'POST'),
      page.locator('form[action="login-local"] button[type=submit]').click(),
    ]);
  } catch { throw new NativeBrowserFailure('login-submit'); }
  const location = response.headers().location;
  const destination = location ? new URL(location, whiskersOrigin) : undefined;
  const failure = destination?.pathname === '/login' ? destination.searchParams.get('error') : null;
  const recognizedFailure = failure === 'invalid' || failure === 'unauthorized' ? failure : 'unexpected';
  if (!destination || destination.origin !== whiskersOrigin || destination.pathname !== '/' || response.status() !== 302) {
    throw new NativeBrowserFailure('login-rejected', 'HTTP ' + response.status() + ', ' + recognizedFailure);
  }
  try {
    await page.waitForURL(url => url.origin === whiskersOrigin && url.pathname === '/', { waitUntil: 'domcontentloaded' });
  } catch { throw new NativeBrowserFailure('login-navigation'); }
}

export async function openPermissions(page: Page) {
  await page.goto(whiskersOrigin + '/settings', { waitUntil: 'domcontentloaded' });
  const field = page.getByPlaceholder('e.g. Claude Code', { exact: true });
  await expect(async () => {
    if (!await field.isVisible()) await page.getByText('MCP permissions', { exact: true }).click({ timeout: 3000 });
    await expect(field).toBeVisible({ timeout: 1800 });
  }).toPass({ timeout: 16_000 });
}

export async function selectWriteLevel(page: Page) {
  const level = page.locator('.mud-input-control.mud-select').filter({
    has: page.locator('label').filter({ hasText: /^Level$/ }),
  });
  try { await level.click(); }
  catch { throw new NativeBrowserFailure('level-control'); }
  try { await page.locator('.mud-popover-open').getByText('Write', { exact: true }).click(); }
  catch { throw new NativeBrowserFailure('level-option'); }
}

export async function createWriteKey(page: Page, name: string) {
  const field = page.getByPlaceholder('e.g. Claude Code', { exact: true });
  await field.fill(name);
  await field.press('Tab');
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
  await expect(row.getByText('Write', { exact: true })).toBeVisible();
  const key = (await row.getByRole('cell').nth(1).innerText()).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid native key');
  return key;
}

export async function approveRestart(page: Page, containerId: string) {
  await page.goto(whiskersOrigin + '/approvals', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.mud-paper.pa-4').filter({ hasText: 'local / ' + containerId }).filter({
    has: page.getByRole('button', { name: 'Approve', exact: true }),
  });
  await expect(card).toHaveCount(1);
  await card.getByText('Parameters (secrets redacted)', { exact: true }).click();
  const pre = card.locator('pre.sw-approval-params');
  await expect(pre).toBeVisible();
  const params: unknown = JSON.parse(await pre.innerText());
  if (!params || typeof params !== 'object' || !('containerId' in params) || !('serverId' in params)
    || params.containerId !== containerId || params.serverId !== 'local' || Object.keys(params).length !== 2
    || !(await card.innerText()).includes(restartTool)) {
    throw new Error('Native approval does not match the fixed request');
  }
  await card.getByRole('button', { name: 'Approve', exact: true }).click();
  const decided = page.getByRole('row').filter({ hasText: restartTool }).filter({ hasText: adminEmail });
  await expect(decided.getByText('Approved', { exact: true })).toBeVisible();
}

export async function observeRestartAudit(page: Page, target: string, actor: string) {
  await page.goto(whiskersOrigin + '/audit-log', { waitUntil: 'domcontentloaded' });
  const restarts = page.getByRole('row').filter({
    has: page.getByText('Container restarted', { exact: true }),
  });
  await expect(restarts).toHaveCount(1);
  await expect(restarts).toContainText(target);
  await expect(restarts.getByText(actor, { exact: true })).toBeVisible();
}
