import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { standardBuildProfileSchema } from '@itervane/contracts';
import { buildLockByteLimit, readBuildDependencies } from '../packages/runner/src/build-dependencies.js';
import { fileDigest } from '../packages/runner/src/guest-inspection.js';
import { readBoundedFile } from '../packages/runner/src/guest-snapshot.js';
import { sha256 } from '../packages/runner/src/profiles.js';

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL('../fixtures/standard-app/', import.meta.url));
const buildRecipe = fileURLToPath(new URL('../fixtures/runner/', import.meta.url));
const tarballLimit = 48 * 1024 * 1024;
const downloadLimit = 192 * 1024 * 1024;
let phase = 'target';

async function verifiedTarball(url: string, integrity: string, remainingBytes: number) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error('build_tarball_unavailable');
  const chunks: Buffer[] = [];
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > Math.min(tarballLimit, remainingBytes)) throw new Error('build_tarball_limit');
    chunks.push(Buffer.from(chunk));
    hash.update(chunk);
  }
  if (size === 0 || `sha512-${hash.digest('base64')}` !== integrity) throw new Error('build_tarball_integrity');
  return Buffer.concat(chunks, size);
}

async function prepare(destination: string) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || basename(destination) !== 'itervane-build-inputs') {
    throw new Error('build_input_target');
  }
  phase = 'lockfile';
  const manifest = readBoundedFile(join(fixture, 'package.json'), 65_536);
  const { lockSha256, tarballs } = readBuildDependencies(readBoundedFile(join(fixture, 'package-lock.json'), buildLockByteLimit));
  const npmRoot = resolve(dirname(process.execPath), '../lib/node_modules/npm');
  const npm = join(npmRoot, 'bin/npm-cli.js');
  await mkdir(destination, { mode: 0o700 });
  const temporary = await mkdtemp(join(destination, '.cache-preparation-'));
  try {
    const cache = join(temporary, 'cache');
    const config = join(temporary, 'global.npmrc');
    await writeFile(config, '', { flag: 'wx', mode: 0o600 });
    const npmConfig = ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier',
      '--userconfig=/dev/null', `--globalconfig=${config}`, `--cache=${cache}`];
    const options = { cwd: temporary, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: temporary },
      timeout: 90_000, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024 };
    phase = 'npm';
    const npmVersion = (await execute(process.execPath, [npm, ...npmConfig, '--version'], options)).stdout.trim();
    if (!/^\d+\.\d+\.\d+$/.test(npmVersion)) throw new Error('build_npm_version');
    phase = 'tarballs';
    const paths: string[] = [];
    let totalBytes = 0;
    for (const [index, { url, integrity }] of tarballs.entries()) {
      const bytes = await verifiedTarball(url, integrity, downloadLimit - totalBytes);
      totalBytes += bytes.length;
      const file = join(temporary, `${index}.tgz`);
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      paths.push(file);
    }
    phase = 'cache';
    await execute(process.execPath, [npm, ...npmConfig, 'cache', 'add', ...paths], options);
    await execute(process.execPath, [npm, ...npmConfig, 'cache', 'verify'], options);
    await mkdir(join(destination, 'npm-cache'), { mode: 0o700 });
    await rename(join(cache, '_cacache'), join(destination, 'npm-cache/_cacache'));
    const inputs = { version: 1, platform: 'linux/amd64', node: process.version, npm: npmVersion,
      packageSha256: sha256(manifest), lockSha256, tarballs, totalBytes,
    };
    const dependencies = JSON.stringify(inputs, null, 2) + '\n';
    await writeFile(join(destination, 'dependencies.json'), dependencies, { flag: 'wx', mode: 0o600 });

    phase = 'profile';
    const baseline = readBoundedFile(join(buildRecipe, 'standard-web-baseline.mjs'), 65_536);
    const viteConfig = readBoundedFile(join(buildRecipe, 'standard-vite.config.mjs'), 4096);
    await cp(npmRoot, join(destination, 'npm'), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    await writeFile(join(destination, 'baseline.mjs'), baseline, { flag: 'wx', mode: 0o600 });
    await writeFile(join(destination, 'vite.config.mjs'), viteConfig, { flag: 'wx', mode: 0o600 });
    const profile = standardBuildProfileSchema.parse({
      version: 1, platform: 'linux/amd64', packageSha256: inputs.packageSha256, lockSha256,
      dependenciesSha256: sha256(dependencies), npmVersion, nodeSha256: await fileDigest(process.execPath, 180 * 1024 * 1024),
      baselineSha256: sha256(baseline), viteConfigSha256: sha256(viteConfig),
    });
    const profileBytes = JSON.stringify(profile);
    await writeFile(join(destination, 'profile.json'), profileBytes, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ...profile, buildProfileSha256: sha256(profileBytes), tarballs: tarballs.length, totalBytes }));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

try {
  const [target, ...extra] = process.argv.slice(2);
  if (!target || extra.length) throw new Error('build_input_arguments');
  await prepare(resolve(target));
} catch (error) {
  const code = error instanceof Error && /^build_[a-z_]+$/.test(error.message) ? error.message : 'preparation_failed';
  console.error(`Trusted build dependency preparation failed at ${phase} (${code}).`);
  process.exitCode = 1;
}
