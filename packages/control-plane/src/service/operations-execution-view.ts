import { eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import { operationsProposals, tasks } from '../persistence/schema.js';
import { requireActor, requireProjectAccess, type Transaction } from './access.js';
import { DomainError } from './errors.js';
import { readOperationsProposal } from './operations-proposals.js';
import { readOperationsTaskRecord } from './operations-records.js';

export async function readOperationsExecutionContext(tx: Transaction, identity: VerifiedIdentity, taskId: string) {
  const actor = await requireActor(tx, identity);
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
  if (!task) throw new DomainError('not_found');
  const { project } = await requireProjectAccess(tx, actor, task.projectId);
  const { run, diagnosis } = await readOperationsTaskRecord(tx, task);
  const [proposal] = diagnosis ? await tx.select().from(operationsProposals).where(eq(operationsProposals.diagnosisRunId, run.id)) : [];
  if (!proposal || !diagnosis) return { actor, project, task, run, proposed: null };
  const frozen = readOperationsProposal(proposal);
  if (frozen.diagnosis.taskId !== taskId || frozen.diagnosis.sha256 !== diagnosis.sha256) throw new Error('operations_execution_view_binding');
  return { actor, project, task, run, proposed: { proposal, frozen } };
}
