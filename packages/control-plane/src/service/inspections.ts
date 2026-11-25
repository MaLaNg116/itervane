import { and, eq, sql } from 'drizzle-orm';
import { idSchema, inspectionPlanSchema, sourceInspectionBlockReasonSchema, sourceInspectionDtoSchema } from '@itervane/contracts';
import { createInspectionPlan, inspectionPlanHash } from '@itervane/runner';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { executionSlot, inspectionPlans, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import type { TaskRow } from '../runtime/authority.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { currentInspectionAttempt, inspectionCoverage, readInspectionEvidence } from './inspection-evidence.js';

function validateStored(row: typeof inspectionPlans.$inferSelect, task: TaskRow, runId: string) {
  const document = inspectionPlanSchema.parse(row.document);
  if (row.taskId !== task.id || row.runId !== runId || document.taskId !== task.id || document.runId !== runId
    || document.requestedSource.repositoryId !== task.repositoryId || document.requestedSource.commit !== task.commit || inspectionPlanHash(document) !== row.sha256) throw new Error('inspection_plan_integrity');
  return { sha256: row.sha256, document, createdAt: row.createdAt.toISOString() };
}

export async function readInspectionPlan(tx: Transaction, task: TaskRow, runId: string) {
  const [row] = await tx.select().from(inspectionPlans).where(eq(inspectionPlans.runId, runId));
  return row ? validateStored(row, task, runId) : null;
}

// Caller is the fenced source.inspect transaction, never an upload/report endpoint.
export async function prepareInspection(tx: Transaction, task: TaskRow, runId: string, fence: number) {
  const existing = await readInspectionPlan(tx, task, runId);
  if (existing) return existing;
  const plan = createInspectionPlan({ taskId: task.id, runId, requestedSource: { repositoryId: task.repositoryId, commit: task.commit } });
  const [created] = await tx.insert(inspectionPlans).values({ taskId: task.id, runId, preparedFence: fence, ...plan }).returning();
  return validateStored(created!, task, runId);
}

export class InspectionService {
  constructor(private readonly database: Database) {}
  async get(identity: VerifiedIdentity, taskId: string) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('share');
      if (!task) throw new DomainError('not_found');
      await requireProject(tx, actor, task.projectId);
      const [run] = await tx.select().from(taskRuns).where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation)));
      if (!run) throw new Error('inspection_run_missing');
      const plan = await readInspectionPlan(tx, task, run.id);
      const coordinates = { taskId: task.id, runId: run.id, requestedSource: { repositoryId: task.repositoryId, commit: task.commit } };
      const unverified = { ...coordinates, sourceFetched: false, snapshotVerified: false, scanCompleted: false };
      if (!plan) return sourceInspectionDtoSchema.parse({ ...unverified, status: 'not_prepared', reason: 'runner_unavailable', plan: null });

      const attempt = await currentInspectionAttempt(tx, run.id);
      if (attempt?.state === 'recorded' && attempt.workspaceSha256) {
        const { receipt, sha256 } = await readInspectionEvidence(tx, attempt, plan);
        const complete = inspectionCoverage(receipt) === 'complete';
        const code = receipt.snapshot.publishedCode?.scan;
        const reports = code?.document.reports ?? [];
        const publishedCode = code && {
          status: reports.some(report => report.status === 'unavailable') ? 'incomplete' : 'complete',
          evidenceSha256: code.sha256, ruleSnapshotSha256: code.document.basis.snapshotSha256,
          checkedFiles: reports.reduce((total, report, index) => total
            + (report.status === 'checked' ? code.document.basis.batches[index]!.fileCount : 0), 0),
          findings: reports.reduce((total, report) => total + (report.status === 'checked' ? report.findings.length : 0), 0),
        };
        return sourceInspectionDtoSchema.parse({ ...coordinates, plan, sourceFetched: true, snapshotVerified: true, scanCompleted: complete,
          status: complete ? 'completed' : 'incomplete', reason: complete ? 'inspection_ready' : 'inspection_incomplete',
          result: { requestId: attempt.requestId, receiptSha256: sha256, snapshotSha256: receipt.snapshot.manifestSha256,
            recordedAt: attempt.settledAt?.toISOString(), files: receipt.snapshot.files, ...(publishedCode ? { publishedCode } : {}),
            scans: receipt.snapshot.reports.map(({ scanner, status, reason, findings, database }) =>
              ({ scanner, status, reason, findingsCount: findings.length, database })) } });
      }
      if (attempt) {
        const [slot] = await tx.select({ live: sql<boolean>`${executionSlot.leaseUntil} > clock_timestamp()` }).from(executionSlot)
          .where(and(eq(executionSlot.runId, run.id), eq(executionSlot.fence, attempt.fence)));
        const active = attempt.state === 'reserved' && slot?.live === true;
        return sourceInspectionDtoSchema.parse({ ...unverified, plan, requestId: attempt.requestId,
          status: active ? 'checking' : 'reconciling', reason: active ? null : 'inspection_reconciling' });
      }
      const [runtime] = await tx.select({ reason: runRuntime.reason }).from(runRuntime).where(eq(runRuntime.runId, run.id));
      const reason = sourceInspectionBlockReasonSchema.safeParse(runtime?.reason);
      return sourceInspectionDtoSchema.parse({ ...unverified, plan, status: 'blocked', reason: reason.success ? reason.data : 'runner_unavailable' });
    });
  }
}
