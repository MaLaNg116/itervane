import { deepStrictEqual, equal, ok, rejects } from 'node:assert/strict';
import { sha256 } from '@itervane/runner';
import type { VerifiedIdentity } from '../../src/auth/identity.js';
import type { Database } from '../../src/persistence/database.js';
import type { OperationsHealthInstallation } from '../../src/service/operations-health.js';
import { OperationsRepairAdmission } from '../../src/service/operations-repair-admission.js';
import { OperationsRepairProposalService, readOperationsRepairProposal } from '../../src/service/operations-repair-proposals.js';

export async function confirmNativeLinkedHealthRepair(database: Database, installation: OperationsHealthInstallation, input: {
  taskId: string; diagnosisSha256: string; incidentId: string; sampleSequence: number; originalOperationId: string; originalCommit: string;
  portalClientId: string; portalOwner: VerifiedIdentity; apiOwner: VerifiedIdentity;
}) {
  const { proposal, replayed } = await new OperationsRepairProposalService(database, installation)
    .freeze(input.apiOwner, input.taskId, { diagnosisSha256: input.diagnosisSha256 });
  equal(replayed, false);
  const frozen = readOperationsRepairProposal(proposal);
  deepStrictEqual(frozen.incident, { id: input.incidentId, sampleSequence: input.sampleSequence });
  equal(frozen.target.releaseOperationId, input.originalOperationId);
  equal(frozen.source.git.commit, input.originalCommit);
  equal(frozen.source.patchSha256, null);
  const admission = new OperationsRepairAdmission(database, installation, input.portalClientId);
  const confirm = { fingerprint: proposal.fingerprint, locale: 'zh-CN' };
  await rejects(admission.confirm(input.apiOwner, proposal.id, confirm), { code: 'forbidden' });
  await rejects(admission.confirm(input.portalOwner, proposal.id, { ...confirm, fingerprint: sha256('stale fixture proposal') }),
    { code: 'version_conflict' });
  const { task, replayed: confirmed } = await admission.confirm(input.portalOwner, proposal.id, confirm);
  equal(confirmed, false);
  equal(task.state, 'queued');
  equal(task.source.commit, input.originalCommit);
  const duplicate = await admission.confirm(input.portalOwner, proposal.id, confirm);
  ok(duplicate.replayed);
  equal(duplicate.task.id, task.id);
  equal(duplicate.task.runId, task.runId);
  return { task, proposalId: proposal.id, proposalFingerprint: proposal.fingerprint, deniedApiOwner: true, deniedStaleFingerprint: true, replayed: true };
}
