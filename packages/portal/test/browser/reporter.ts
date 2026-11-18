import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sourceFingerprint } from '../../../verification/src/report.js';

// Do not publish locator call logs, request headers, OAuth parameters or passwords.
export default class SafeReporter implements Reporter {
  private results: { title: string; status: string; diagnostic?: string }[] = [];
  onStdOut() { /* Browser and SDK logs are deliberately excluded. */ }
  onStdErr() { /* Do not forward third-party raw errors or request data. */ }
  onError() { console.error('Browser worker failed; raw diagnostic omitted.'); }
  onTestEnd(test: TestCase, result: TestResult) {
    const category = !result.error ? '' : result.status === 'timedOut' ? 'Timed out' : result.error.message?.includes('expect(') ? 'Assertion failed' : 'Test execution failed';
    const location = result.error?.stack?.match(/(?:portal\.spec|stack)\.ts:\d+:\d+/)?.[0] ?? '';
    const diagnostic = [category, location].filter(Boolean).join(' ');
    this.results.push({ title: test.title, status: result.status, ...(diagnostic ? { diagnostic } : {}) });
    console.log(`${result.status}: ${test.title}${diagnostic ? ` — ${diagnostic}` : ''}`);
  }
  async onEnd(result: FullResult) {
    const report = { status: result.status, checkedAt: new Date().toISOString(), sourceFingerprint: await sourceFingerprint(),
      passed: this.results.filter(test => test.status === 'passed').length, total: this.results.length, tests: this.results };
    const root = resolve('.reports/p1-c'); await mkdir(root, { recursive: true });
    await writeFile(resolve(root, 'browser.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`Browser verification: ${report.passed}/${report.total}, ${report.status}`);
  }
}
