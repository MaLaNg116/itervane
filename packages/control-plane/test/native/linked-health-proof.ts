import { deepStrictEqual, equal, notEqual, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { admissionDtoSchema, operationsIncidentsViewSchema, operationsIncidentStopResultSchema, operationsRepairViewSchema,
  taskIncidentViewSchema, type TaskDto } from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import type { OperationsHealthWorker } from '../../src/runtime/installed-health-worker.js';
import type { DiagnosisReaders } from './restart-proof.js';

export async function confirmNativeLinkedHealthRepair(input: {
  diagnosis: TaskDto; diagnosisSha256: string; incidentId: string; sampleSequence: number;
  environmentId: string; originalOperationId: string; originalCommit: string;
  readers: DiagnosisReaders; repeatSample: OperationsHealthWorker['tick']; markPhase: (phase: string) => void;
}) {
  const { diagnosis, diagnosisSha256, incidentId, sampleSequence, environmentId, originalOperationId, originalCommit, markPhase } = input;
  const { request, mcp, withEnglishReader } = input.readers;
  const scope = { projectId: diagnosis.projectId, environmentId };
  const historyPath = `/v1/projects/${scope.projectId}/environments/${environmentId}/operations-incidents`;
  const incidentPath = (taskId: string) => `/v1/tasks/${taskId}/operations-incident`;
  const taskReference = { taskId: diagnosis.id };

  markPhase('linked_health_read_incident');
  const chinese = operationsIncidentsViewSchema.parse(await request(historyPath));
  deepStrictEqual(operationsIncidentsViewSchema.parse((await mcp.callTool({ name: 'list_operations_incidents', arguments: scope })).structuredContent), chinese);
  const english = await withEnglishReader(async reader => {
    const view = operationsIncidentsViewSchema.parse((await reader.callTool({ name: 'list_operations_incidents', arguments: scope })).structuredContent);
    deepStrictEqual(view, operationsIncidentsViewSchema.parse(await request(historyPath, { locale: 'en' })));
    return view;
  });
  const original = chinese.items.find(item => item.id === incidentId);
  const translated = english.items.find(item => item.id === incidentId);
  ok(original && translated);
  notEqual(original.message, translated.message);
  equal(original.latestSample.sequence, sampleSequence);
  equal(original.latestSample.signal.status, 'unhealthy');
  equal(original.releaseOperationId, originalOperationId);
  equal(original.restoreExecutionId, null);
  equal(original.diagnosisStop, null);
  equal(original.diagnoses.length, 1);
  const [diagnosed] = original.diagnoses;
  equal(diagnosed?.taskId, diagnosis.id);
  equal(diagnosed?.runId, diagnosis.runId);
  equal(diagnosed?.sampleSequence, sampleSequence);
  equal(diagnosed?.state, 'succeeded');
  const beforeStop = taskIncidentViewSchema.parse(await request(incidentPath(diagnosis.id)));
  equal(beforeStop.relatedAs, 'diagnosis');
  deepStrictEqual(beforeStop.incident, original);
  equal(beforeStop.stopDiagnosis, null);
  deepStrictEqual(taskIncidentViewSchema.parse((await mcp.callTool({ name: 'get_task_incident', arguments: taskReference })).structuredContent), beforeStop);
  const portalView = taskIncidentViewSchema.parse(await request(incidentPath(diagnosis.id), { portal: true }));
  deepStrictEqual(portalView.stopDiagnosis, scope);

  markPhase('linked_health_stop_diagnosis');
  const stopPath = `${historyPath}/${incidentId}/stop-diagnosis`;
  const payload = { expectedReleaseOperationId: originalOperationId, expectedRestoreExecutionId: null };
  await request(stopPath, { payload, status: 403 });
  await request(stopPath, { payload: { ...payload, expectedReleaseOperationId: randomUUID() }, portal: true, status: 409 });
  const stop = operationsIncidentStopResultSchema.parse(await request(stopPath, { payload, portal: true }));
  const sameStop = operationsIncidentStopResultSchema.parse(await request(stopPath, { payload, portal: true }));
  equal(stop.incidentId, incidentId);
  equal(stop.reason, 'operator_stopped');
  equal(stop.replayed, false);
  deepStrictEqual(sameStop, { ...stop, replayed: true });
  const observed = await input.repeatSample();
  ok(observed.status === 'recorded');
  equal(observed.outcome.status, 'unhealthy');
  equal(observed.incidentId, incidentId);
  ok(observed.sequence > sampleSequence);
  deepStrictEqual(observed.diagnosis, { status: 'stopped', reason: 'operator_stopped' });
  const afterStop = taskIncidentViewSchema.parse(await request(incidentPath(diagnosis.id), { portal: true }));
  equal(afterStop.stopDiagnosis, null);
  equal(afterStop.incident?.diagnosisStop?.at, stop.stoppedAt);
  equal(afterStop.incident?.latestSample.sequence, observed.sequence);
  equal(afterStop.incident?.diagnoses.length, 1);
  deepStrictEqual(taskIncidentViewSchema.parse((await mcp.callTool({ name: 'get_task_incident', arguments: taskReference })).structuredContent), afterStop);

  markPhase('linked_health_interface_proposal');
  const repairPath = `/v1/tasks/${diagnosis.id}/operations-repair`;
  const draft = operationsRepairViewSchema.parse(await request(repairPath));
  deepStrictEqual(draft.draft, { diagnosisSha256 });
  const prepared = operationsRepairViewSchema.parse((await mcp.callTool({
    name: 'request_operations_repair', arguments: { ...taskReference, diagnosisSha256 },
  })).structuredContent);
  deepStrictEqual(operationsRepairViewSchema.parse(await request(repairPath)), prepared);
  const proposal = prepared.proposal;
  ok(proposal?.status === 'pending');
  equal(proposal.incidentId, incidentId);
  deepStrictEqual(proposal.target, { environmentId, releaseOperationId: originalOperationId, restoreExecutionId: null });
  equal(proposal.source.commit, originalCommit);
  equal(proposal.source.requiresMaterializedCommit, false);
  equal(proposal.mayConfirm, false);
  equal(operationsRepairViewSchema.parse(await request(repairPath, { portal: true })).proposal?.mayConfirm, true);

  markPhase('linked_health_interface_confirmation');
  const confirmPath = `/v1/operations/repair-proposals/${proposal.id}/confirm`;
  const confirm = { fingerprint: proposal.fingerprint, locale: 'zh-CN' };
  await request(confirmPath, { payload: confirm, status: 403 });
  await request(confirmPath, { payload: { ...confirm, fingerprint: sha256('stale fixture proposal') }, portal: true, status: 409 });
  const { task, replayed } = admissionDtoSchema.parse(await request(confirmPath, { payload: confirm, portal: true, status: 202 }));
  equal(replayed, false);
  equal(task.state, 'queued');
  equal(task.projectId, scope.projectId);
  equal(task.source.commit, originalCommit);
  const duplicate = admissionDtoSchema.parse(await request(confirmPath, { payload: confirm, portal: true, status: 200 }));
  ok(duplicate.replayed);
  deepStrictEqual(duplicate.task, task);
  const confirmed = operationsRepairViewSchema.parse(await request(repairPath));
  equal(confirmed.proposal?.status, 'confirmed');
  equal(confirmed.proposal?.linkedTask?.taskId, task.id);
  equal(confirmed.proposal?.linkedTask?.runId, task.runId);
  deepStrictEqual(operationsRepairViewSchema.parse((await mcp.callTool({ name: 'get_operations_repair', arguments: taskReference })).structuredContent), confirmed);
  const linked = taskIncidentViewSchema.parse(await request(incidentPath(task.id)));
  equal(linked.relatedAs, 'linked_repair');
  equal(linked.incident?.id, incidentId);
  deepStrictEqual(linked.incident?.repairs, [{ proposalId: proposal.id, diagnosisRunId: diagnosis.runId, taskId: task.id, state: 'queued' }]);
  deepStrictEqual(taskIncidentViewSchema.parse((await mcp.callTool({ name: 'get_task_incident', arguments: { taskId: task.id } })).structuredContent), linked);
  return { task, proposalId: proposal.id, proposalFingerprint: proposal.fingerprint, deniedApiOwner: true, deniedStaleFingerprint: true, replayed: true,
    incidentInterfaces: { httpMcpAgreement: true, bilingual: true, stopReplay: true, stopDeniedWithoutPortal: true, stopBoundToRelease: true,
      stoppedAt: stop.stoppedAt, stoppedSampleSequence: observed.sequence, stopReason: stop.reason, linkedTaskId: task.id } };
}
