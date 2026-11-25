import { chmodSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  qualifiedGuestVerificationProofSchema, qualifiedStandardBuildProofSchema, standardBuildDispatchSchema, standardBuildProfileSchema,
  publishedVerificationProofByteLimit, type QualifiedStandardBuildProof,
} from '@itervane/contracts';
import { readGuestCandidate } from './guest-repair.js';
import { readBoundedFile } from './guest-snapshot.js';
import { readGuestVerificationSource } from './guest-verification-source.js';
import { sha256 } from './profiles.js';
import { compareVerificationScans } from './verification-scan-comparison.js';

export const STANDARD_BUILD_INPUT = '/var/lib/itervane-build-input';
export const STANDARD_BUILD_TOOLS = '/usr/local/libexec/itervane-build';
const rootFiles = ['index.html', 'package.json', 'package-lock.json'];
const requiredFiles = [...rootFiles, 'src/main.jsx', 'server/index.mjs', 'server/app.mjs'];
type BlockCode = Extract<QualifiedStandardBuildProof, { status: 'blocked' }>['code'];

/** Stage only the declared standard application inputs from the verified source. */
export function stageGuestStandardBuild(source: string, scanReceipt: string, tools: string, output: string) {
  const { command, fixed } = readGuestVerificationSource(source);
  const { input } = command;
  const { profile, subject } = input;
  const proof = qualifiedGuestVerificationProofSchema.parse(JSON.parse(
    readBoundedFile(scanReceipt, publishedVerificationProofByteLimit).toString('utf8'),
  ));
  if (!profile.buildProfileSha256 || proof.build !== undefined || proof.runId !== fixed.runId
      || proof.commit !== input.source.commit || proof.repositoryId !== input.source.repositoryId
      || proof.manifestSha256 !== fixed.manifest.sha256 || proof.inputsSha256 !== profile.scannerInputsSha256
      || proof.verificationInputSha256 !== command.inputSha256 || proof.commandSha256 !== sha256(command.bytes)
      || (subject.kind === 'original' ? proof.target !== null
        : proof.target?.manifestSha256 !== subject.manifestSha256 || proof.target?.patchSha256 !== subject.patchSha256)) {
    throw new Error('standard_build_scan_binding');
  }
  const binding = {
    version: 1, runId: fixed.runId, verificationInputSha256: command.inputSha256,
    subjectManifestSha256: subject.manifestSha256, buildProfileSha256: profile.buildProfileSha256,
    baselineSha256: profile.baselineSha256,
  };
  const block = (code: BlockCode) => {
    const proof = qualifiedStandardBuildProofSchema.parse({ ...binding, status: 'blocked', code });
    // The scanner and acquisition identities are distinct from the builder.
    writeFileSync(join(output, 'blocked.json'), JSON.stringify(proof), { flag: 'wx', mode: 0o440 });
  };
  if (compareVerificationScans(proof, proof.target ?? proof).status !== 'compared') return block('scan_incomplete');
  const profilePath = join(tools, 'profile.json');
  if (!lstatSync(profilePath, { throwIfNoEntry: false })) return block('profile_unavailable');
  const profileBytes = readBoundedFile(profilePath, 4096);
  const approved = standardBuildProfileSchema.parse(JSON.parse(profileBytes.toString('utf8')));
  if (sha256(profileBytes) !== profile.buildProfileSha256 || approved.baselineSha256 !== profile.baselineSha256) {
    return block('profile_mismatch');
  }
  const files = (subject.kind === 'repair' ? readGuestCandidate(join(source, 'candidate'), subject.manifestSha256).files : fixed.files)
    .filter(file => rootFiles.includes(file.path) || file.path.startsWith('src/') || file.path.startsWith('server/'))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const entries = files.map(({ path, content }) => ({ path, sha256: sha256(content), bytes: content.length }));
  const paths = new Map(entries.map(entry => [entry.path, entry.sha256]));
  if (!requiredFiles.every(path => paths.has(path))) return block('source_layout');
  if (paths.get('package.json') !== approved.packageSha256 || paths.get('package-lock.json') !== approved.lockSha256) {
    return block('profile_mismatch');
  }
  const dispatch = standardBuildDispatchSchema.parse({ ...binding, projectionSha256: sha256(JSON.stringify(entries)) });
  const staging = mkdtempSync(join(output, '.build-input-'));
  try {
    for (const file of files) {
      const target = join(staging, 'project', file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o750 });
      writeFileSync(target, file.content, { flag: 'wx', mode: 0o440 });
    }
    writeFileSync(join(staging, 'request.json'), JSON.stringify(dispatch), { flag: 'wx', mode: 0o440 });
    chmodSync(staging, 0o2750);
    renameSync(staging, join(output, 'ready'));
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
