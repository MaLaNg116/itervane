import { expect, type Page } from '@playwright/test';
import { restartTool, whiskersOrigin } from '../../../verification/src/native/whiskers.js';
import { adminEmail } from './whiskers-fixture.js';

export async function signIn(page: Page, password: string) {
  await page.goto(whiskersOrigin + '/set-culture?culture=en&redirect=/login');
  await page.locator('input[name=email]').fill(adminEmail);
  await page.locator('input[name=password]').fill(password);
  await page.locator('form[action="login-local"] button[type=submit]').click();
  await page.waitForURL(url => url.origin === whiskersOrigin && url.pathname === '/');
}

export async function openPermissions(page: Page) {
  await page.goto(whiskersOrigin + '/settings');
  const field = page.getByPlaceholder('e.g. Claude Code', { exact: true });
  await expect(async () => {
    if (!await field.isVisible()) await page.getByText('MCP permissions', { exact: true }).click({ timeout: 3000 });
    await expect(field).toBeVisible({ timeout: 1800 });
  }).toPass({ timeout: 16_000 });
  await page.getByLabel('Level', { exact: true }).click();
  await page.getByRole('option', { name: 'Write', exact: true }).click();
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
  await page.goto(whiskersOrigin + '/approvals');
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
