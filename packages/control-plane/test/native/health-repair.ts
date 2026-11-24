import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { standardHealthRepairPath, type FormalVerificationInput, type QualifiedInspectionReceipt, type RepairPatch } from '@itervane/contracts';
import { canonicalRepairCommand, sha256, type QualifiedInspectionClient } from '@itervane/runner';

export function correctSyntheticHealthApp(sourceText: string) {
  const counter = /^  let healthRequests = 0;\n/m;
  const returning503 = /^    if \(\+\+healthRequests > 1\) \{\n[\s\S]*?^    \}\n/m;
  ok(counter.test(sourceText) && returning503.test(sourceText) && sourceText.includes('fixture-health-repeat'));
  return sourceText.replace(counter, '').replace(returning503, '');
}

export async function repairNativeHealthFixture(runner: QualifiedInspectionClient, original: QualifiedInspectionReceipt,
  input: FormalVerificationInput, runAuthority: { fence: number; origin: string; authorize: () => Promise<void>; signal: AbortSignal },
  healthReproductionSha256: string) {
  const { taskId, runId, projectId, generation, source, inspection } = input;
  const workspace = { version: 1 as const, operationId: randomUUID(), source, baseSnapshotSha256: inspection.snapshotSha256,
    repairInputSha256: sha256(JSON.stringify(input)), healthReproductionSha256, protectedPaths: ['server/index.mjs', 'package.json', 'package-lock.json'] };
  const { signal, authorize } = runAuthority;
  const coordinates = async (operationId: string) => {
    const status = await runner.observe(signal);
    ok(status?.state === 'idle');
    return { version: 1 as const, requestId: randomUUID(), taskId, runId, projectId, generation, ...source,
      fence: runAuthority.fence, origin: runAuthority.origin, workspaceSha256: status.workspaceSha256,
      operationId, baseSnapshotSha256: workspace.baseSnapshotSha256, repairInputSha256: workspace.repairInputSha256 };
  };
  const path = standardHealthRepairPath;
  const observation = await runner.observeRepair(await coordinates(workspace.operationId), workspace,
    [{ findingId: healthReproductionSha256, path, kind: 'health_reproduction', line: null }], authorize, signal);
  ok(observation.kind === 'repair_observation' && observation.cleanupConfirmed);
  const [target] = observation.snapshot.observation.targets;
  ok(target && 'kind' in target && target.status === 'text' && target.sourceText && target.range && target.file);
  equal(observation.commitSha256, original.commitSha256);
  equal(observation.snapshot.tree, original.snapshot.tree);
  equal(observation.snapshot.manifestSha256, original.snapshot.manifestSha256);
  notEqual(observation.domainId, original.domainId);

  // This fixture corrects only its known counting defect using the bytes returned by the VM.
  const replacement = correctSyntheticHealthApp(target.sourceText);
  const patch: RepairPatch = { version: 1, baseSnapshotSha256: workspace.baseSnapshotSha256, files: [{
    path, beforeSha256: target.file.sha256, edits: [{ startByte: target.range.startByte, endByte: target.range.endByte, replacement }],
  }] };
  const apply = { ...workspace, operationId: randomUUID(), editablePaths: [path] };
  const command = canonicalRepairCommand(apply, patch);
  const receipt = await runner.repair(await coordinates(apply.operationId), command.workspace, command.patch, authorize, signal);
  ok(receipt.kind === 'repair_receipt' && receipt.cleanupConfirmed);
  notEqual(receipt.domainId, observation.domainId);
  notEqual(receipt.domainId, original.domainId);
  equal(receipt.commitSha256, original.commitSha256);
  const { candidate } = receipt.snapshot;
  deepStrictEqual(candidate.changes, [{ path, beforeSha256: target.file.sha256, beforeBytes: target.file.bytes,
    afterSha256: sha256(replacement), afterBytes: Buffer.byteLength(replacement), edits: 1 }]);
  const receiptSha256 = sha256(JSON.stringify(receipt));
  const subject = { kind: 'repair' as const, operationId: receipt.scope.operationId, requestId: receipt.scope.requestId,
    inputSha256: workspace.repairInputSha256, resultSha256: sha256(JSON.stringify(candidate)), checkpointId: randomUUID(),
    receiptSha256, commandSha256: receipt.scope.commandSha256, manifestSha256: candidate.candidateManifestSha256,
    patchSha256: candidate.patchSha256 };
  return { subject, repair: { workspace: command.workspace, patch: command.patch },
    proof: { observationDomainId: observation.domainId, repairDomainId: receipt.domainId, cleanupConfirmed: true,
      previousReceiptSha256: healthReproductionSha256, observationReceiptSha256: sha256(JSON.stringify(observation)),
      path, patchSha256: candidate.patchSha256, beforeSha256: target.file.sha256, afterSha256: candidate.changes[0]!.afterSha256 } };
}
