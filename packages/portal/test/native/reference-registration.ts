import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv, promisify } from 'node:util';

const execute = promisify(execFile);
type Registration = 'release-target' | 'operations-target' | 'operations-restart-installation' | 'operations-incident-monitor';

export async function registerReferenceTarget(directory: string, kind: Registration, document: unknown): Promise<unknown> {
  const file = join(directory, kind + '-' + randomUUID() + '.json');
  await writeFile(file, JSON.stringify(document), { flag: 'wx', mode: 0o600 });
  const environment = parseEnv(await readFile(join(directory, 'api.env'), 'utf8'));
  const result = await execute(process.execPath, ['--import', 'tsx', 'packages/control-plane/src/entries/register-' + kind + '.ts', file], {
    timeout: 20_000, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...environment },
  });
  return JSON.parse(result.stdout) as unknown;
}
