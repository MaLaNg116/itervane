import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execute = promisify(execFile);
const assets = {
  gitleaks: { repository: 'gitleaks/gitleaks', version: '8.30.1',
    win32: ['gitleaks_8.30.1_windows_x64.zip', 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'],
    linux: ['gitleaks_8.30.1_linux_x64.tar.gz', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'] },
  trivy: { repository: 'aquasecurity/trivy', version: '0.76.2',
    win32: ['trivy_0.76.2_windows-64bit.zip', '691f737a7e5566a673c3a74dab9160552ec32101e953b659e5c77443d16dddb6'],
    linux: ['trivy_0.76.2_Linux-64bit.tar.gz', 'bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf'] },
} as const;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function scannerTools() {
  if ((process.platform !== 'linux' && process.platform !== 'win32') || process.arch !== 'x64') throw new Error('scanner_platform_unsupported');
  const platform = process.platform; const directory = resolve('.cache/p1-d-tools', platform); await mkdir(directory, { recursive: true });
  const tools = {} as Record<keyof typeof assets, string>;
  for (const name of ['gitleaks', 'trivy'] as const) {
    const asset = assets[name]; const [file, digest] = asset[platform]; const archive = resolve(directory, file);
    let bytes = await readFile(archive).catch(() => undefined);
    if (!bytes) {
      const response = await fetch(`https://github.com/${asset.repository}/releases/download/v${asset.version}/${file}`, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw new Error('scanner_download_failed');
      let length = 0; const chunks: Buffer[] = [];
      for await (const part of response.body) { length += part.length; if (length > 160 * 1024 * 1024) throw new Error('scanner_archive_limit'); chunks.push(Buffer.from(part)); }
      bytes = Buffer.concat(chunks);
    }
    if (hash(bytes) !== digest) throw new Error('scanner_archive_integrity');
    await writeFile(archive, bytes);
    const binary = name + (platform === 'win32' ? '.exe' : '');
    const extracted = await execute('tar', ['-xOf', archive, binary], { encoding: 'buffer', maxBuffer: 180 * 1024 * 1024, timeout: 30_000 });
    tools[name] = resolve(directory, binary); await writeFile(tools[name], extracted.stdout, { mode: 0o755 });
    // The verified archive is rechecked/extracted on every run; a mutable receipt cannot authorize another binary.
    console.log(`Verified ${name} ${asset.version} archive SHA-256 ${digest}`);
  }
  return tools;
}
