import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Schema, type CodeRuleValidationProfile } from '@itervane/contracts';
import { maxSemgrepReportBytes, normalizeCodeRuleSample, prepareCodeRuleValidation, summarizeCodeRuleSamples } from '@itervane/rules';
import { z } from 'zod';
import { readBoundedFile } from './guest-snapshot.js';
import { sha256 } from './profiles.js';

export const semgrepEngineDirectory = '/usr/local/libexec/itervane-semgrep';
const maxManifestBytes = 4 * 1024 * 1024;
const maxFiles = 16_384;
const maxTotalBytes = 384 * 1024 * 1024;
const enginePathSchema = z.string().min(1).max(384).refine(file => file.split('/').every(segment =>
  segment && segment !== '.' && segment !== '..' && !/[\\:\u0000-\u001f\u007f]/.test(segment)));
const fileEntrySchema = z.strictObject({ path: enginePathSchema, bytes: z.int().min(0).max(maxTotalBytes), sha256: sha256Schema, executable: z.boolean() });
const engineInputsSchema = z.strictObject({
  version: z.literal(1), engine: z.literal('semgrep_ce'), engineVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  lockSha256: sha256Schema, directories: z.array(enginePathSchema).min(1).max(maxFiles), files: z.array(fileEntrySchema).min(1).max(maxFiles),
});
type EngineFile = z.infer<typeof fileEntrySchema>;

function verifyFileTree(directory: string, files: readonly EngineFile[], directories: readonly string[]) {
  const entries = new Map(files.map(item => [item.path, item]));
  const seen = new Set<string>();
  const expectedDirectories = new Set(directories);
  if (expectedDirectories.size !== directories.length) throw new Error('semgrep_engine_layout');
  let bytes = 0;
  function walk(relative = '', depth = 0) {
    if (depth > 24 || seen.size > maxFiles) throw new Error('semgrep_engine_layout');
    for (const name of readdirSync(join(directory, relative))) {
      const child = relative ? relative + '/' + name : name;
      if (child === 'inputs.json') continue;
      const info = lstatSync(join(directory, child));
      if (info.isDirectory()) {
        if (!expectedDirectories.delete(child)) throw new Error('semgrep_engine_layout');
        walk(child, depth + 1);
        continue;
      }
      const entry = entries.get(child);
      if (!entry || !info.isFile() || entry.bytes !== info.size || entry.executable !== Boolean(info.mode & 0o111)) {
        throw new Error('semgrep_engine_layout');
      }
      seen.add(child);
      bytes += info.size;
      if (bytes > maxTotalBytes) throw new Error('semgrep_engine_layout');
    }
  }
  walk();
  if (expectedDirectories.size || entries.size !== files.length || entries.size !== seen.size || !entries.has('entry.py')
      || ![...entries.values()].some(item => item.path === 'site/semgrep/bin/semgrep-core' && item.executable)) {
    throw new Error('semgrep_engine_layout');
  }
}

export async function verifySemgrepEngine(directory: string, profile: CodeRuleValidationProfile) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) {
    throw new Error('semgrep_engine_platform');
  }
  const original = readBoundedFile(join(directory, 'inputs.json'), maxManifestBytes);
  if (sha256(original) !== profile.engineInputsSha256) throw new Error('semgrep_engine_fingerprint');
  const inputs = engineInputsSchema.parse(JSON.parse(original.toString('ascii')));
  if (inputs.engineVersion !== profile.engineVersion) throw new Error('semgrep_engine_version');
  verifyFileTree(directory, inputs.files, inputs.directories);
  for (const file of inputs.files) {
    const handle = await open(join(directory, file.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.bytes) throw new Error('semgrep_engine_content');
      for await (const piece of handle.createReadStream({ autoClose: false })) {
        bytes += piece.length;
        if (bytes > file.bytes) throw new Error('semgrep_engine_content');
        digest.update(piece);
      }
    } finally { await handle.close(); }
    if (bytes !== file.bytes || digest.digest('hex') !== file.sha256) throw new Error('semgrep_engine_content');
  }
  return { version: inputs.engineVersion, files: inputs.files.length, lockSha256: inputs.lockSha256 };
}

type Prepared = ReturnType<typeof prepareCodeRuleValidation>;

// The caller runs this inside the sealed scan service. The provisioning smoke uses only the tracked synthetic sample.
export async function runPreparedCodeRuleSamples(directory: string, prepared: Prepared) {
  await verifySemgrepEngine(directory, prepared.basis.profile);
  const { config, basis, files } = prepared;
  if (sha256(config) !== basis.configSha256 || files.length !== basis.samples.length || files.some(({ name, file, sha256: digest, content }, index) =>
    name !== basis.samples[index]?.name || file !== basis.samples[index]?.file || digest !== basis.samples[index]?.sha256 || sha256(content) !== digest)) {
    throw new Error('rule_validation_material_integrity');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'itervane-rule-samples-'));
  try {
    writeFileSync(join(temporary, 'rule.json'), config, { flag: 'wx', mode: 0o400 });
    for (const file of files) writeFileSync(join(temporary, file.file), file.content, { flag: 'wx', mode: 0o400 });
    const results = files.map(({ file, name }) => {
      const result = spawnSync('/usr/bin/python3', ['-I', '-B', join(directory, 'entry.py'), 'scan',
        '--metrics=off', '--disable-version-check', '--disable-nosem', '--no-git-ignore', '--no-rewrite-rule-ids',
        '--strict', '--max-target-bytes=6400', '--timeout=8', '--jobs=1', '--json', '--quiet', '--config', 'rule.json', file], {
        cwd: temporary, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: temporary, XDG_CACHE_HOME: temporary },
        maxBuffer: maxSemgrepReportBytes, timeout: 12_000, killSignal: 'SIGKILL', encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return normalizeCodeRuleSample(basis, name, { exitCode: result.status,
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
    });
    return summarizeCodeRuleSamples(basis, results);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
