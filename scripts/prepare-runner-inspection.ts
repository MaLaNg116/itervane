import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { MAX_DATABASE_BYTES, databaseUpdatedAt, fileDigest, type InspectionInputs } from '../packages/runner/src/guest-inspection.js';
import { gitleaksConfig, sha256, trivyConfig } from '../packages/runner/src/profiles.js';
import { scannerTools } from './scanner-tools.js';

const execute = promisify(execFile);
const limit = 180 * 1024 * 1024;
const databaseRepository = 'ghcr.io/aquasecurity/trivy-db:2';

async function prepare(root: string) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || basename(root) !== 'itervane-inspection') throw new Error('invalid-target');
  const tools = await scannerTools();
  await mkdir(root, { mode: 0o755 });
  const path = (name: string) => resolve(root, name);
  const runtime = path('node');
  const worker = path('worker.mjs');
  const gitleaks = path('gitleaks');
  const trivy = path('trivy');
  await copyFile(process.execPath, runtime, constants.COPYFILE_EXCL);
  await copyFile(tools.gitleaks, gitleaks, constants.COPYFILE_EXCL);
  await copyFile(tools.trivy, trivy, constants.COPYFILE_EXCL);
  await Promise.all([runtime, gitleaks, trivy].map(file => chmod(file, 0o755)));
  await build({
    entryPoints: ['packages/runner/src/entries/guest-inspection.ts'],
    outfile: worker, bundle: true, platform: 'node', format: 'esm', target: 'node24',
  });
  await mkdir(path('policy'));
  await writeFile(path('policy/gitleaks.toml'), gitleaksConfig);
  await writeFile(path('policy/trivy.yaml'), trivyConfig);
  await writeFile(path('policy/empty.ignore'), '');

  const preparation = path('download');
  await execute(trivy, ['image', '--download-db-only', '--db-repository', databaseRepository,
    '--cache-dir', preparation, '--no-progress'], {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: preparation },
    timeout: 145_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
  });
  await mkdir(path('cache'));
  await rename(path('download/db'), path('cache/db'));
  // An empty directory carries no staged inputs.
  const metadata = await readFile(path('cache/db/metadata.json'));
  if (metadata.length > 4096) throw new Error('invalid-database-metadata');
  const inputs: InspectionInputs = {
    nodeSha256: await fileDigest(runtime, limit),
    workerSha256: await fileDigest(worker, 4 * 1024 * 1024),
    gitleaksSha256: await fileDigest(gitleaks, limit),
    trivySha256: await fileDigest(trivy, limit),
    databaseSha256: await fileDigest(path('cache/db/trivy.db'), MAX_DATABASE_BYTES),
    databaseMetadataSha256: sha256(metadata),
    databaseUpdatedAt: databaseUpdatedAt(metadata),
  };
  if (Date.now() - Date.parse(inputs.databaseUpdatedAt) > 72 * 3600_000
      || Date.parse(inputs.databaseUpdatedAt) > Date.now() + 300_000) throw new Error('stale-database');
  const serialized = JSON.stringify(inputs, null, 2) + '\n';
  await writeFile(path('inputs.json'), serialized, { flag: 'wx' });
  console.log(JSON.stringify({ databaseRepository, inputsSha256: sha256(serialized), ...inputs }));
}

try {
  const [root, ...extra] = process.argv.slice(2);
  if (!root || extra.length) throw new Error('invalid-target');
  await prepare(resolve(root));
} catch {
  console.error('Trusted scanner input preparation failed.');
  process.exitCode = 1;
}
