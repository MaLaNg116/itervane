import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { checkSchema, summarizeChecks, type Check, type ProbeReport } from '@itervane/contracts';

export function report(probe: string, checks: Check[]): ProbeReport {
  checks.forEach(c => checkSchema.parse(c));
  return { probe, runId: randomUUID(), checkedAt: new Date().toISOString(), status: summarizeChecks(checks), checks };
}

export async function sourceFingerprint(): Promise<string> {
  const hash = createHash('sha256');
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (/\.(ts|tsx|json|mjs|js|jsx|css|html|yaml|yml|sql)$/.test(entry.name) || entry.name === 'Dockerfile')) files.push(path);
    }
  }
  for (const directory of ['packages', 'scripts', 'fixtures', 'evaluation']) await walk(resolve(directory));
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts', 'vitest.integration.config.ts']) files.push(resolve(name));
  for (const file of files.sort()) hash.update(relative(process.cwd(), file).replaceAll('\\', '/')).update('\0').update(await readFile(file)).update('\0');
  return hash.digest('hex');
}

export async function saveReport(value: ProbeReport): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/.test(value.probe)) throw new Error('Invalid report name');
  const directory = resolve('.reports/p0');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `${value.probe}.json`), JSON.stringify({ ...value, sourceFingerprint: await sourceFingerprint() }, null, 2) + '\n', { mode: 0o600 });
}

export async function executeProbe(name: string, probe: () => Promise<ProbeReport>): Promise<number> {
  let result: ProbeReport;
  try { result = await probe(); }
  catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const unavailable = ['APIUserAbortError', 'APIConnectionError', 'TimeoutError'].includes(errorName);
    result = report(name, [{ id: 'probe-execution', status: unavailable ? 'blocked' : 'failed', detail: `Probe could not complete (${errorName}); raw SDK errors, endpoints and credentials are omitted.` }]);
  }
  await saveReport(result);
  console.log(JSON.stringify(result, null, 2));
  return result.status === 'passed' ? 0 : result.status === 'blocked' ? 2 : 1;
}
