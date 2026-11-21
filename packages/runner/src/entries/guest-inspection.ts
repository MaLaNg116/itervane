import { lstatSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qualifiedGuestRepairIssueSchema } from '@itervane/contracts';
import { repairQualifiedGuestSnapshot } from '../guest-repair.js';
import { observeQualifiedRepairTargets } from '../guest-repair-observation.js';
import { publishGuestSnapshot } from '../guest-snapshot.js';
import { INSPECTION_OUTPUT, INSPECTION_SOURCE, INSPECTION_TOOLS, inspectGuestSnapshot, inspectionFailures } from '../guest-inspection.js';

const [command, ...args] = process.argv.slice(2);
process.umask(0o027);
if (command === 'snapshot' && args.length === 5) {
  const [repository, runId, commit, repositoryId, mode] = args as [string, string, string, string, string];
  try {
    if (mode !== 'fixture' && mode !== 'qualified' && mode !== 'repair' && mode !== 'repair-observation') throw new Error('snapshot-mode');
    publishGuestSnapshot(INSPECTION_SOURCE, repository, runId, { repositoryId, commit }, mode);
  } catch { process.exitCode = 1; }
} else if (command === 'scan' && args.length === 0 && process.env.ITERVANE_SCAN_BOUNDARY === 'verified') {
  const repair = lstatSync(join(INSPECTION_SOURCE, 'repair-command.json'), { throwIfNoEntry: false }) !== undefined;
  const observeRepair = lstatSync(join(INSPECTION_SOURCE, 'repair-observation.json'), { throwIfNoEntry: false }) !== undefined;
  let receipt: object;
  try {
    if (repair && observeRepair) throw new Error('repair-integrity');
    receipt = observeRepair ? observeQualifiedRepairTargets(INSPECTION_SOURCE)
      : repair ? repairQualifiedGuestSnapshot(INSPECTION_SOURCE, INSPECTION_OUTPUT)
      : await inspectGuestSnapshot(join(INSPECTION_SOURCE, 'ready'), INSPECTION_TOOLS);
  }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const issue = qualifiedGuestRepairIssueSchema.safeParse(message);
    const invalidEdit = ['repair-range', 'repair-text', 'repair-size', 'repair-no-change'].includes(message);
    const code = repair || observeRepair ? issue.data ?? (invalidEdit ? 'repair-invalid' : 'repair-integrity')
      : inspectionFailures.find(value => message === value) ?? 'scan-integrity';
    receipt = { code };
  }
  try {
    const pending = join(INSPECTION_OUTPUT, 'receipt.pending');
    writeFileSync(pending, JSON.stringify(receipt), { flag: 'wx', mode: 0o440 });
    renameSync(pending, join(INSPECTION_OUTPUT, 'receipt.json'));
  } catch { process.exitCode = 1; }
} else if (command !== 'self-check' || args.length !== 0) { process.exitCode = 1; }
