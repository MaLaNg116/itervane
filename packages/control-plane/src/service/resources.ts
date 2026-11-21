import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  applicationDtoSchema, applicationInputSchema, environmentDtoSchema, environmentInputSchema,
  idSchema, listQuerySchema, meDtoSchema, projectAccessDtoSchema, projectDtoSchema, projectInputSchema, repositoryDtoSchema, repositoryInputSchema,
} from '@itervane/contracts';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { applications, environments, principals, projectMembers, projects, repositories, workspaceMembers, workspaces } from '../persistence/schema.js';
import { requireActor, requireProject } from './access.js';
import { DomainError, parseInput } from './errors.js';

const projectView = (row: typeof projects.$inferSelect) => projectDtoSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const repositoryView = (row: typeof repositories.$inferSelect) => repositoryDtoSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const applicationView = (row: typeof applications.$inferSelect) => applicationDtoSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const environmentView = (row: typeof environments.$inferSelect) => environmentDtoSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });

// 仅本机维护命令调用；HTTP 没有“首个登录者自动成为管理员”的入口。
export async function bootstrapOwner(database: Database, raw: unknown) {
  const input = z.object({ issuer: z.string().url().max(2_048), subject: z.string().min(1).max(255) }).strict().parse(raw);
  return database.db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('itervane:bootstrap:v1', 0))`);
    const existing = await tx.select({ principalId: principals.id, workspaceId: workspaces.id, issuer: principals.issuer, subject: principals.subject })
      .from(workspaces).innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .innerJoin(principals, eq(principals.id, workspaceMembers.principalId));
    if (existing[0]) {
      if (existing[0].issuer !== input.issuer || existing[0].subject !== input.subject) throw new DomainError('conflict');
      return { principalId: existing[0].principalId, workspaceId: existing[0].workspaceId };
    }
    if ((await tx.select().from(workspaces)).length) throw new DomainError('conflict');
    const [principal] = await tx.insert(principals).values({ issuer: input.issuer, subject: input.subject })
      .onConflictDoUpdate({ target: [principals.issuer, principals.subject], set: { issuer: input.issuer } }).returning();
    const workspaceId = randomUUID();
    await tx.insert(workspaces).values({ id: workspaceId, name: 'Personal workspace' });
    await tx.insert(workspaceMembers).values({ workspaceId, principalId: principal!.id });
    return { principalId: principal!.id, workspaceId };
  });
}

export class ResourceService {
  constructor(private readonly database: Database) {}

  async me(identity: VerifiedIdentity) {
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      return meDtoSchema.parse({ principalId: actor.principalId, workspaceId: actor.workspaceId, isWorkspaceOwner: actor.workspaceId !== null });
    });
  }

  async createProject(identity: VerifiedIdentity, raw: unknown) {
    const input = parseInput(projectInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      if (!actor.workspaceId) throw new DomainError('forbidden');
      const [row] = await tx.insert(projects).values({ ...input, workspaceId: actor.workspaceId }).returning();
      return projectView(row!);
    });
  }

  async projectAccess(identity: VerifiedIdentity, projectId: string) {
    parseInput(idSchema, projectId);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); const project = await requireProject(tx, actor, projectId);
      const [member] = await tx.select().from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.principalId, actor.principalId)));
      const role = actor.workspaceId === project.workspaceId ? 'owner' : member!.role;
      return projectAccessDtoSchema.parse({ projectId, role, canWrite: role !== 'viewer' });
    });
  }

  async getProject(identity: VerifiedIdentity, projectId: string) {
    parseInput(idSchema, projectId);
    return this.database.db.transaction(async tx => projectView(await requireProject(tx, await requireActor(tx, identity), projectId)));
  }

  async listProjects(identity: VerifiedIdentity, limit: number) {
    limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity);
      if (actor.workspaceId) return (await tx.select().from(projects).where(eq(projects.workspaceId, actor.workspaceId)).orderBy(desc(projects.createdAt), desc(projects.id)).limit(limit)).map(projectView);
      return (await tx.select({ project: projects }).from(projects).innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
        .where(eq(projectMembers.principalId, actor.principalId)).orderBy(desc(projects.createdAt), desc(projects.id)).limit(limit)).map(row => projectView(row.project));
    });
  }

  async registerRepository(identity: VerifiedIdentity, projectId: string, raw: unknown) {
    parseInput(idSchema, projectId); const input = parseInput(repositoryInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, projectId, true);
      const [row] = await tx.insert(repositories).values({ ...input, projectId }).returning();
      return repositoryView(row!);
    });
  }

  async listRepositories(identity: VerifiedIdentity, projectId: string, limit: number) {
    parseInput(idSchema, projectId); limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, projectId);
      return (await tx.select().from(repositories).where(eq(repositories.projectId, projectId)).orderBy(desc(repositories.createdAt), desc(repositories.id)).limit(limit)).map(repositoryView);
    });
  }

  async createApplication(identity: VerifiedIdentity, projectId: string, raw: unknown) {
    parseInput(idSchema, projectId); const input = parseInput(applicationInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, projectId, true);
      const [row] = await tx.insert(applications).values({ ...input, projectId }).returning();
      return applicationView(row!);
    });
  }

  async listApplications(identity: VerifiedIdentity, projectId: string, limit: number) {
    parseInput(idSchema, projectId); limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, projectId);
      return (await tx.select().from(applications).where(eq(applications.projectId, projectId)).orderBy(desc(applications.createdAt), desc(applications.id)).limit(limit)).map(applicationView);
    });
  }

  async createEnvironment(identity: VerifiedIdentity, projectId: string, raw: unknown) {
    parseInput(idSchema, projectId); const input = parseInput(environmentInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, projectId, true);
      const [application] = await tx.select().from(applications).where(and(eq(applications.id, input.applicationId), eq(applications.projectId, projectId))).for('share');
      if (!application) throw new DomainError('not_found');
      const [row] = await tx.insert(environments).values({ ...input, projectId }).returning();
      return environmentView(row!);
    });
  }

  async listEnvironments(identity: VerifiedIdentity, projectId: string, limit: number) {
    parseInput(idSchema, projectId); limit = parseInput(listQuerySchema, { limit }).limit;
    return this.database.db.transaction(async tx => {
      const actor = await requireActor(tx, identity); await requireProject(tx, actor, projectId);
      return (await tx.select().from(environments).where(eq(environments.projectId, projectId)).orderBy(desc(environments.createdAt), desc(environments.id)).limit(limit)).map(environmentView);
    });
  }
}
