import { chromium, type Browser } from '@playwright/test';
import { whiskersOrigin } from '../../../verification/src/native/whiskers.js';
import { eligibleHost, operatorEmail, WhiskersFixture } from './whiskers-fixture.js';
import { approveRestart, observeRestartAudit, signIn } from './whiskers-ui.js';

export async function openNativeWhiskersRestartScope() {
  if (!eligibleHost()) throw new Error('operations_whiskers_restart_host');
  const fixture = new WhiskersFixture();
  let browser: Browser | undefined;
  const close = async () => {
    try { await browser?.close(); }
    finally { if (!await fixture.close()) throw new Error('operations_whiskers_restart_cleanup'); }
  };
  try {
    await fixture.start('published-restart');
    browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === whiskersOrigin ? route.continue() : route.abort());
    await signIn(page, fixture.operatorPassword, operatorEmail);
    return {
      origin: whiskersOrigin, serverId: 'local', readKey: fixture.readKey, writeKey: fixture.writers.primary,
      installationFiles: (scope: { environmentId: string; enrollmentSha256: string }) => fixture.restartInstallationFiles(fixture.writers.primary, scope),
      approve: (containerId: string) => approveRestart(page, containerId, operatorEmail),
      verifyAudit: (containerName: string) => observeRestartAudit(page, containerName, fixture.primaryWriter),
      close,
    };
  } catch {
    await close();
    throw new Error('operations_whiskers_restart_setup');
  }
}
