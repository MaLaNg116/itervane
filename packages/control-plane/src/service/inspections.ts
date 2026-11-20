import { and, eq } from 'drizzle-orm';
import { idSchema, inspectionPlanSchema, sourceInspectionDtoSchema } from '@itervane/contracts';
import { createInspectionPlan, inspectionPlanHash } from '@itervane/runner';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { inspectionPlans, taskRuns, tasks } from '../persistence/schema.js';
import type { TaskRow } from '../runtime/authority.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';

function validateStored(row: typeof inspectionPlans.$inferSelect, task: TaskRow, runId: string) {
  const document = inspectionPlanSchema.parse(row.document);
  if (row.taskId !== task.id || row.runId !== runId || document.taskId !== task.id || document.runId !== runId
    || document.requestedSource.repositoryId !== task.repositoryId || document.requestedSource.commit !== task.commit || inspectionPlanHash(document) !== row.sha256) throw new Error('inspection_plan_integrity');
  return { sha256: row.sha256, document, createdAt: row.createdAt.toISOString() };
}

// Caller is the fenced source.inspect transaction, never an upload/report endpoint.
export async function prepareInspection(tx: Transaction, task: TaskRow, runId: string, fence: number) {
  const [existing] = await tx.select().from(inspectionPlans).where(eq(inspectionPlans.runId, runId));
  if (existing) return validateStored(existing, task, runId);
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
      const [row] = await tx.select().from(inspectionPlans).where(eq(inspectionPlans.runId, run.id));
      return sourceInspectionDtoSchema.parse({ taskId: task.id, runId: run.id, requestedSource: { repositoryId: task.repositoryId, commit: task.commit },
        status: row ? 'blocked' : 'not_prepared', reason: 'runner_unavailable', sourceFetched: false, snapshotVerified: false, scanCompleted: false,
        plan: row ? validateStored(row, task, run.id) : null });
    });
  }
}
