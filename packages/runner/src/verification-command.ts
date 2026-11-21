import { verificationCommandByteLimit, verificationCommandSchema } from '@itervane/contracts';
import { sha256 } from './profiles.js';
import { canonicalRepairCommand } from './repair-command.js';

export function canonicalVerificationCommand(raw: unknown) {
  const { input, repair } = verificationCommandSchema.parse(raw);
  const { subject, source, inspection } = input;
  const command = repair && canonicalRepairCommand(repair.workspace, repair.patch);
  if (subject.kind === 'repair') {
    if (!command || sha256(command.bytes) !== subject.commandSha256 || command.patchSha256 !== subject.patchSha256
      || command.workspace.operationId !== subject.operationId || command.workspace.repairInputSha256 !== subject.inputSha256
      || command.workspace.baseSnapshotSha256 !== inspection.snapshotSha256
      || command.workspace.source.repositoryId !== source.repositoryId || command.workspace.source.commit !== source.commit) {
      throw new Error('verification-repair-binding');
    }
  } else if (command) {
    throw new Error('verification-repair-binding');
  }
  const material = command && { workspace: command.workspace, patch: command.patch };
  const bytes = Buffer.from(JSON.stringify({ input, repair: material }));
  if (bytes.length > verificationCommandByteLimit) throw new Error('verification-command-limit');
  return { input, repair: material, inputSha256: sha256(JSON.stringify(input)), bytes };
}
