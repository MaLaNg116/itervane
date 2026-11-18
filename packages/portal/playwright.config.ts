import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({ testDir: './test/browser', testMatch: '**/*.spec.ts', workers: 1, fullyParallel: false, retries: 0, maxFailures: 1,
  timeout: 60_000, globalTimeout: 300_000, expect: { timeout: 12_000 },
  outputDir: resolve('.reports/p1-c/test-output'), reporter: [['./test/browser/reporter.ts']],
  use: { browserName: 'chromium', ...(process.platform === 'win32' ? { channel: 'chrome' } : {}), headless: true,
    viewport: { width: 1365, height: 960 }, reducedMotion: 'reduce', trace: 'off', screenshot: 'off', video: 'off' },
});
