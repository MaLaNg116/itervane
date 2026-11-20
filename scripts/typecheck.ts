import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

for (const args of [[], ['--project', 'packages/portal/tsconfig.json']]) {
  const code = await new Promise<number>(done => {
    const child = spawn(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', ...args], { stdio: 'inherit' });
    child.once('error', () => done(1)); child.once('exit', value => done(value ?? 1));
  });
  if (code !== 0) { process.exitCode = code; break; }
}
