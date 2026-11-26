import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const git = (...args: string[]) => execute('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
type PackageLicense = { name: string; version: string; license: string };

async function installedLicenses() {
  let input = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    input += chunk;
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error('license inventory too large');
  }
  const groups = JSON.parse(input) as Record<string, { name: string; versions: string[] }[]>;
  const packages = new Map<string, PackageLicense>();
  for (const [license, entries] of Object.entries(groups)) {
    if (!license.trim() || !Array.isArray(entries)) throw new Error('invalid license inventory');
    for (const { name, versions } of entries) {
      if (!name || !Array.isArray(versions) || !versions.length) throw new Error('invalid licensed package');
      for (const version of versions) {
        if (typeof version !== 'string' || !version) throw new Error('invalid dependency version');
        const key = `${name}@${version}`;
        const existing = packages.get(key);
        if (existing && existing.license !== license) throw new Error('inconsistent license declarations');
        packages.set(key, { name, version, license });
      }
    }
  }
  if (!packages.size) throw new Error('install the locked packages before indexing their licenses');
  return [...packages.keys()].sort().map(key => packages.get(key)!);
}

async function describeFile(directory: string, filename: string) {
  const bytes = await readFile(join(directory, filename));
  return { filename, bytes: bytes.length, sha256: sha256(bytes) };
}

let phase = 'validate_arguments';
try {
  const [directory, ...additional] = process.argv.slice(2);
  if (!directory || additional.length) throw new Error('provide a new output directory');
  const output = resolve(directory);

  phase = 'validate_checkout';
  if ((await git('rev-parse', '--show-prefix')).stdout.trim()) throw new Error('run packaging from the repository root');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('diff', '--quiet', commit, '--');
  const tree = (await git('rev-parse', `${commit}^{tree}`)).stdout.trim();
  const tracked = (await git('ls-tree', '-r', '--name-only', '-z', commit)).stdout;
  const forbidden = /(?:^|\/)(?:\.env(?:\.(?!example(?:\/|$))[^/]*)?|node_modules|\.reports|\.cache|dist)(?:\/|$)/;
  if (tracked.split('\0').some(path => forbidden.test(path))) throw new Error('tracked private or generated files');
  const { name, version, packageManager } = JSON.parse((await git('show', `${commit}:package.json`)).stdout) as
    { name: string; version: string; packageManager: string };
  if (name !== 'itervane' || !/^\d+\.\d+\.\d+$/.test(version) || !/^pnpm@\d+\.\d+\.\d+$/.test(packageManager)) {
    throw new Error('invalid release coordinates');
  }
  const packageManagerAgent = process.env.npm_config_user_agent?.split(' ')[0]?.replace('/', '@');
  if (packageManagerAgent !== packageManager) throw new Error('use the pinned package manager');

  phase = 'collect_licenses';
  const packages = await installedLicenses();
  const toolchain = { node: process.version, packageManager, platform: process.platform, architecture: process.arch };
  const basename = `${name}-${version}`;
  const archive = basename + '.tar.gz';
  const licenses = 'dependency-licenses.json';
  const release = 'release-manifest.json';
  const lockfile = Buffer.from((await git('show', `${commit}:pnpm-lock.yaml`)).stdout);

  phase = 'package_files';
  await mkdir(output);
  await git('archive', '--format=tar.gz', '--prefix=' + basename + '/', '--output=' + join(output, archive), commit);
  await writeFile(join(output, licenses), json({ schemaVersion: 1, toolchain, packages }), { flag: 'wx' });
  const files = await Promise.all([describeFile(output, archive), describeFile(output, licenses)]);
  const manifest = { schemaVersion: 1, release: `v${version}`, commit, tree, toolchain, files,
    lockfile: { filename: 'pnpm-lock.yaml', bytes: lockfile.length, sha256: sha256(lockfile) }, componentNotices: 'docs/release-components.md' };
  await writeFile(join(output, release), json(manifest), { flag: 'wx' });
  files.push(await describeFile(output, release));
  await writeFile(join(output, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.filename}\n`).join(''), { flag: 'wx' });
  console.log(JSON.stringify({ release: manifest.release, commit, tree, artifacts: [...files.map(file => file.filename), 'SHA256SUMS'] }));
} catch {
  console.error(`Source release packaging failed in ${phase}. Use a clean checkout with locked dependencies and a new output directory.`);
  process.exitCode = 1;
}
