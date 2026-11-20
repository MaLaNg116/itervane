import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { report, saveReport } from '../packages/verification/src/report.js';

async function run(entry: string, args: string[]) {
  return new Promise<number>(resolveCode => {
    const child = spawn(process.execPath, [resolve(entry), ...args], { stdio: 'inherit' });
    child.once('error', () => resolveCode(1));
    child.once('exit', code => resolveCode(code ?? 1));
  });
}
const types = await run('node_modules/typescript/bin/tsc', ['--noEmit']);
const tests = types === 0 ? await run('node_modules/vitest/vitest.mjs', ['run']) : 1;
const result = report('engineering', [
  { id: 'strict-types', status: types === 0 ? 'passed' : 'failed', detail: 'TypeScript strict checking.' },
  { id: 'unit-contracts', status: tests === 0 ? 'passed' : 'failed', detail: 'Contract, protocol and bounded loop regression tests.' },
]);
await saveReport(result);
process.exitCode = result.status === 'passed' ? 0 : 1;
