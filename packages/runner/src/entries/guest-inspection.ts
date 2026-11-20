import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishGuestSnapshot } from '../guest-snapshot.js';
import {
  INSPECTION_OUTPUT, INSPECTION_SOURCE, INSPECTION_TOOLS, PROBE_REPOSITORY_ID, inspectGuestSnapshot, inspectionFailures,
} from '../guest-inspection.js';

const [command, ...args] = process.argv.slice(2);
process.umask(0o027);
if (command === 'snapshot' && args.length === 3) {
  const [repository, runId, commit] = args as [string, string, string];
  try {
    publishGuestSnapshot(INSPECTION_SOURCE, repository, runId, { repositoryId: PROBE_REPOSITORY_ID, commit });
  } catch { process.exitCode = 1; }
} else if (command === 'scan' && args.length === 0 && process.env.ITERVANE_SCAN_BOUNDARY === 'verified') {
  let receipt: object;
  try { receipt = await inspectGuestSnapshot(join(INSPECTION_SOURCE, 'ready'), INSPECTION_TOOLS); }
  catch (error) {
    const code = inspectionFailures.find(value => error instanceof Error && error.message === value) ?? 'scan-integrity';
    receipt = { code };
  }
  try {
    const pending = join(INSPECTION_OUTPUT, 'receipt.pending');
    writeFileSync(pending, JSON.stringify(receipt), { flag: 'wx', mode: 0o440 });
    renameSync(pending, join(INSPECTION_OUTPUT, 'receipt.json'));
  } catch { process.exitCode = 1; }
} else { process.exitCode = 1; }
