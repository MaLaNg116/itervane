import { join } from 'node:path';
import { qualifiedGuestRepairObservationSchema, repairCommandByteLimit, type RepairTarget } from '@itervane/contracts';
import { readRepairSource, repairText } from './guest-repair-source.js';
import { readBoundedFile } from './guest-snapshot.js';
import { sha256 } from './profiles.js';
import { canonicalRepairObservation, protectedRepairPath } from './repair-command.js';

function observedLine(content: Buffer, line: number | null) {
  if (line === null) return null;
  let startByte = 0;
  for (let current = 1; current < line; current++) {
    const newline = content.indexOf(10, startByte);
    if (newline < 0) return null;
    startByte = newline + 1;
  }
  if (startByte === content.length) return null;
  const newline = content.indexOf(10, startByte);
  const endByte = newline < 0 ? content.length : newline + 1;
  return { startByte, endByte, sha256: sha256(content.subarray(startByte, endByte)) };
}

const simpleAssignment = /^[ \t]*(?:export[ \t]+)?[a-z_][a-z0-9_]*[ \t]*=[ \t]*(?:[a-z0-9_.@/:+%~=-]+|"[^"\\$`\r\n]+"|'[^'\r\n]+')[ \t]*(?:#[^\r\n]*)?\r?$/i;
const blankOrComment = /^[ \t]*(?:#[^\r\n]*)?\r?$/;

function templateHints(target: RepairTarget, text: string, range: NonNullable<ReturnType<typeof observedLine>>, line: Buffer) {
  // A hint describes syntax only. The original key and value remain inside the sealed guest.
  if (target.scanner !== 'gitleaks' || text.length > 65536 || range.endByte - range.startByte > 4096
      || !/(?:^|\/)\.env(?:\.[a-z0-9_-]+)?$/i.test(target.path)) return [];
  return simpleAssignment.test(line.toString('utf8').replace(/\n$/, ''))
    && text.split('\n').every(value => blankOrComment.test(value) || simpleAssignment.test(value))
    ? ['remove-env-entry-v1' as const] : [];
}

export function observeQualifiedRepairTargets(source: string) {
  const bytes = readBoundedFile(join(source, 'repair-observation.json'), repairCommandByteLimit);
  let command: ReturnType<typeof canonicalRepairObservation>;
  try { command = canonicalRepairObservation(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new Error('repair-invalid'); }
  if (!bytes.equals(command.bytes)) throw new Error('repair-invalid');
  const { fixed, proof } = readRepairSource(source, bytes, 'repair-observation');
  const { workspace } = command;
  if (workspace.source.repositoryId !== proof.repositoryId || workspace.source.commit !== proof.commit
      || workspace.baseSnapshotSha256 !== proof.manifestSha256) throw new Error('repair-base');
  const content = new Map(fixed.files.map(file => [file.path, file.content]));
  const metadata = new Map(fixed.manifest.files.map(file => [file.path, { sha256: file.sha256, bytes: file.bytes }]));
  const targets = command.targets.map(target => {
    const base = { ...target, range: null, file: null, templates: [] };
    if (protectedRepairPath(target.path, workspace.protectedPaths)) return { ...base, status: 'protected' };
    const value = content.get(target.path);
    const file = metadata.get(target.path);
    if (!value || !file) return { ...base, status: 'missing' };
    const text = repairText(value);
    if (text === null) return { ...base, file, status: 'binary' };
    const range = observedLine(value, target.line);
    const templates = range ? templateHints(target, text, range, value.subarray(range.startByte, range.endByte)) : [];
    return { ...base, file, range, templates, status: 'text' };
  });
  const observation = {
    version: 1, operationId: workspace.operationId, repairInputSha256: workspace.repairInputSha256,
    baseSnapshotSha256: workspace.baseSnapshotSha256, targets,
  };
  return qualifiedGuestRepairObservationSchema.parse({ ...proof, observation });
}
