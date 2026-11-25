import { join } from 'node:path';
import { publishedVerificationCommandByteLimit } from '@itervane/contracts';
import { publishGuestVerificationCandidate } from './guest-repair.js';
import { readBoundedFile, readGuestSnapshotData } from './guest-snapshot.js';
import { canonicalVerificationCommand } from './verification-command.js';

export const verificationCommandName = 'verification-command.json';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function readGuestVerificationSource(source: string) {
  const commandBytes = readBoundedFile(join(source, verificationCommandName), publishedVerificationCommandByteLimit);
  const command = canonicalVerificationCommand(JSON.parse(decoder.decode(commandBytes)));
  const fixed = readGuestSnapshotData(join(source, 'ready'));
  const { input } = command;
  if (!commandBytes.equals(command.bytes) || fixed.mode !== 'verification'
      || fixed.manifest.source.repositoryId !== input.source.repositoryId || fixed.manifest.source.commit !== input.source.commit
      || fixed.manifest.sha256 !== input.inspection.snapshotSha256) throw new Error('verify-binding');
  return { command, fixed };
}

export function publishGuestVerificationSource(source: string) {
  const { command, fixed } = readGuestVerificationSource(source);
  if (command.repair) publishGuestVerificationCandidate(source, fixed, command.repair, command.input.subject.manifestSha256);
}
