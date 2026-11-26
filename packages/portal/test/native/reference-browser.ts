import { equal } from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Locator, Page } from '@playwright/test';

export async function untilResult<T>(read: () => Promise<T | undefined>, timeout = 65_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(500);
  }
  throw new Error('reference_result_timeout');
}

export async function portalPost(page: Page, path: string, button: Locator, status: number) {
  const observed = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST');
  await button.click();
  const response = await observed;
  equal(response.status(), status);
  return response.json() as Promise<unknown>;
}
