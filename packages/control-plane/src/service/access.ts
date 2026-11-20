import { and, eq } from 'drizzle-orm';
import type { Database } from '../persistence/database.js';
import { principals, projectMembers, projects, workspaceMembers } from '../persistence/schema.js';
import { assertVerifiedIdentity, type VerifiedIdentity } from '../auth/identity.js';
import { DomainError } from './errors.js';

export type Transaction = Parameters<Parameters<Database['db']['transaction']>[0]>[0];
export type Actor = { principalId: string; workspaceId: string | null };

export async function requireActor(tx: Transaction, identity: VerifiedIdentity): Promise<Actor> {
  assertVerifiedIdentity(identity);
  const [principal] = await tx.select().from(principals)
    .where(and(eq(principals.issuer, identity.issuer), eq(principals.subject, identity.subject))).for('share');
  if (!principal) throw new DomainError('forbidden');
  return requireStoredActor(tx, principal.id);
}

// Worker 只使用领域接受任务时保存的主体；它不能从 checkpoint 或队列自报权限。
export async function requireStoredActor(tx: Transaction, principalId: string): Promise<Actor> {
  const [principal] = await tx.select().from(principals).where(eq(principals.id, principalId)).for('share');
  if (!principal) throw new DomainError('forbidden');
  // 权限只查当前领域记录；短事务内共享锁使撤销与当前命令有明确先后顺序。
  const [owner] = await tx.select().from(workspaceMembers).where(eq(workspaceMembers.principalId, principal.id)).for('share');
  return { principalId: principal.id, workspaceId: owner?.workspaceId ?? null };
}

export async function requireProject(tx: Transaction, actor: Actor, projectId: string, write = false) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('share');
  if (!project) throw new DomainError('not_found');
  if (project.workspaceId === actor.workspaceId) return project;
  const [member] = await tx.select().from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.principalId, actor.principalId))).for('share');
  if (!member) throw new DomainError('not_found');
  if (write && member.role !== 'maintainer') throw new DomainError('forbidden');
  return project;
}
