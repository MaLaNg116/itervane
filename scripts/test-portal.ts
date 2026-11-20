import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
for (const step of [
  { cwd: resolve('packages/portal'), file: resolve('packages/portal/node_modules/vite/bin/vite.js'), args: ['build'] },
  { cwd: root, file: resolve('packages/portal/node_modules/@playwright/test/cli.js'), args: ['test', '--config', 'packages/portal/playwright.config.ts', ...process.argv.slice(2)] },
]) {
  const code = await new Promise<number>(done => {
    const child = spawn(process.execPath, [step.file, ...step.args], { cwd: step.cwd, stdio: 'inherit' });
    child.once('error', () => done(1)); child.once('exit', value => done(value ?? 1));
  });
  if (code !== 0) { process.exitCode = code; break; }
}
