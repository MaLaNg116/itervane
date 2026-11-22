import { chromium } from '@playwright/test';
import { whiskersOrigin } from '../../../verification/src/native/whiskers.js';
import { eligibleHost, WhiskersFixture } from './whiskers-fixture.js';
import { createMcpKey, openPermissions, selectKeyLevel, signIn } from './whiskers-ui.js';

export async function openNativeWhiskersReadScope() {
  if (!eligibleHost()) throw new Error('operations_whiskers_host');
  const fixture = new WhiskersFixture();
  const close = async () => {
    if (!await fixture.close()) throw new Error('operations_whiskers_cleanup');
  };
  try {
    await fixture.start('published-read-only');
    const browser = await chromium.launch({ channel: 'chrome' });
    try {
      const page = await browser.newPage();
      await page.route('**/*', route => new URL(route.request().url()).origin === whiskersOrigin ? route.continue() : route.abort());
      await signIn(page, fixture.adminPassword);
      await openPermissions(page);
      await selectKeyLevel(page, 'Read');
      const readKey = await createMcpKey(page, 'itervane-published-observation', 'Read');
      return { origin: whiskersOrigin, serverId: 'local', readKey, close };
    } finally { await browser.close(); }
  } catch {
    await close();
    throw new Error('operations_whiskers_setup');
  }
}
