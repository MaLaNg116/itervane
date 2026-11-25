import { and, eq, sql } from 'drizzle-orm';
import { taskRuleSnapshotSchema, taskRuleSnapshotViewSchema, translate, type Locale, type RuleSnapshotPurpose } from '@itervane/contracts';
import { digest } from '@itervane/rules';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { projects, taskRuleSnapshots, tasks } from '../persistence/schema.js';
import { requireActor, requireProject, type Transaction } from './access.js';
import { DomainError } from './errors.js';
import { databaseNow } from './releases.js';

export class TaskRuleSnapshotChanged extends DomainError {
  constructor() { super('version_conflict'); }
}

export async function lockRuleLibrary(tx: Transaction, workspaceId: string, writing: boolean) {
  await tx.execute(sql`SELECT itervane.lock_rule_library(${workspaceId}::uuid, ${writing}::boolean)`);
}

async function currentTaskRules(tx: Transaction, task: { id: string; projectId: string }, purpose: RuleSnapshotPurpose) {
  const [project] = await tx.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, task.projectId));
  if (!project) throw new DomainError('not_found');
  await lockRuleLibrary(tx, project.workspaceId, false);
  const { rows: [selected] } = await tx.execute<{ entries: unknown }>(sql`
    SELECT itervane.active_rule_references(${task.projectId}::uuid, ${purpose}::text) AS entries
  `);
  const parsed = taskRuleSnapshotSchema.safeParse({ version: 1, taskId: task.id, projectId: task.projectId, purpose, entries: selected?.entries });
  if (!parsed.success) throw new DomainError('unavailable');
  return parsed.data;
}

export async function recordTaskRuleSnapshot(tx: Transaction, task: { id: string; projectId: string }, purpose: RuleSnapshotPurpose) {
  const document = await currentTaskRules(tx, task, purpose);
  await tx.insert(taskRuleSnapshots).values({ taskId: task.id, projectId: task.projectId, purpose,
    sha256: digest(JSON.stringify(document)), document, createdAt: await databaseNow(tx) });
}

/** Take the same shared library lock as admission while granting an effect against a frozen snapshot. */
export async function requireCurrentTaskRules(tx: Transaction, task: { id: string; projectId: string }, purpose: RuleSnapshotPurpose, expectedSha256?: string) {
  const active = await currentTaskRules(tx, task, purpose);
  const pinned = await readTaskRuleSnapshot(tx, task);
  const changed = pinned ? pinned.sha256 !== digest(JSON.stringify(active)) : active.entries.length > 0;
  if (changed || (expectedSha256 !== undefined && pinned?.sha256 !== expectedSha256)) throw new TaskRuleSnapshotChanged();
  return pinned;
}

export async function readTaskRuleSnapshot(tx: Transaction, task: { id: string; projectId: string }) {
  const [row] = await tx.select().from(taskRuleSnapshots).where(and(eq(taskRuleSnapshots.taskId, task.id), eq(taskRuleSnapshots.projectId, task.projectId)));
  if (!row) return null;
  const document = taskRuleSnapshotSchema.parse(row.document);
  if (document.taskId !== task.id || document.projectId !== task.projectId || document.purpose !== row.purpose
    || digest(JSON.stringify(document)) !== row.sha256) throw new Error('task_rule_snapshot_integrity');
  return { sha256: row.sha256, document, recordedAt: row.createdAt.toISOString() };
}

export class TaskRuleSnapshotService {
  constructor(private readonly database: Database) {}

  async get(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      const [task] = await tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
      if (!task) throw new DomainError('not_found');
      await requireProject(tx, actor, task.projectId);
      const snapshot = await readTaskRuleSnapshot(tx, task);
      const message = snapshot ? snapshot.document.entries.length ? 'rule_snapshot.recorded' : 'rule_snapshot.empty' : 'rule_snapshot.not_recorded';
      return taskRuleSnapshotViewSchema.parse({ taskId: task.id, locale, snapshot, message: translate(locale, message) });
    });
  }
}
