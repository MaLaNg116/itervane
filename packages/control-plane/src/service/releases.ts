import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  fixtureReleaseManifestSchema, idSchema, releaseCandidateDtoSchema, releaseDecisionInputSchema, translate,
  type FixtureReleaseManifest, type Locale, type ReleaseCandidateStatus,
} from '@itervane/contracts';
import type { VerifiedIdentity } from '../auth/identity.js';
import { releaseFixtureQueue, type Database } from '../persistence/database.js';
import { environments, projects, releaseCandidates, releaseDecisions, releaseOperations, taskRuns, tasks, workspaceMembers } from '../persistence/schema.js';
import { enqueueReleaseOperation } from '../runtime/release-queue.js';
import { requireActor, requireProject, requireStoredActor, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';

type CandidateRow = typeof releaseCandidates.$inferSelect;
type DecisionRow = typeof releaseDecisions.$inferSelect;
type EvidenceScope = Readonly<Pick<FixtureReleaseManifest, 'taskId' | 'runId' | 'projectId' | 'generation' | 'source'>>;
type TaskScope = { binding: EvidenceScope; requestedBy: string; waiting: boolean };

export interface FixtureReleaseEvidence {
  // The trusted reader uses this transaction to pin its current revision.
  readCurrent(tx: Transaction, scope: EvidenceScope): Promise<unknown>;
}

function fingerprint(manifest: FixtureReleaseManifest) {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export function parseFrozenRelease(candidate: CandidateRow) {
  const parsed = fixtureReleaseManifestSchema.safeParse(candidate.document);
  if (!parsed.success || fingerprint(parsed.data) !== candidate.fingerprint) throw new DomainError('unavailable');
  return parsed.data;
}

export async function databaseNow(tx: Transaction) {
  const { rows } = await tx.execute<{ milliseconds: string }>(sql`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS milliseconds
  `);
  const milliseconds = Number(rows[0]?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new DomainError('unavailable');
  return new Date(milliseconds);
}

async function lockTaskScope(tx: Transaction, taskId: string, lock: 'share' | 'update'): Promise<TaskScope> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for(lock);
  if (!task) throw new DomainError('not_found');
  const [run] = await tx.select().from(taskRuns)
    .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.generation, task.generation))).for('share');
  if (!run) throw new DomainError('unavailable');
  return {
    binding: {
      taskId, runId: run.id, projectId: task.projectId, generation: run.generation,
      source: { repositoryId: task.repositoryId, commit: task.commit },
    },
    requestedBy: task.requestedBy,
    waiting: task.dataClass === 'synthetic' && task.state === 'waiting_approval' && run.state === 'waiting_approval',
  };
}

function matchesTask(manifest: FixtureReleaseManifest, task: TaskScope) {
  const { binding } = task;
  return task.waiting && manifest.taskId === binding.taskId && manifest.runId === binding.runId
    && manifest.projectId === binding.projectId && manifest.generation === binding.generation
    && manifest.source.repositoryId === binding.source.repositoryId && manifest.source.commit === binding.source.commit;
}

async function latestCandidate(tx: Transaction, taskId: string) {
  const [latest] = await tx.select().from(releaseCandidates).where(eq(releaseCandidates.taskId, taskId))
    .orderBy(desc(releaseCandidates.evidenceVersion)).limit(1);
  return latest;
}

async function ownerGrant(tx: Transaction, workspaceId: string, principalId: string) {
  const [member] = await tx.select({ id: workspaceMembers.grantId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.principalId, principalId))).for('share');
  return member?.id;
}

function present(candidate: CandidateRow, manifest: FixtureReleaseManifest, decisions: DecisionRow[], status: ReleaseCandidateStatus, locale: Locale) {
  return releaseCandidateDtoSchema.parse({
    id: candidate.id, fingerprint: candidate.fingerprint, requestedBy: candidate.requestedBy,
    createdAt: candidate.createdAt.toISOString(), origin: manifest.origin, releaseEligible: manifest.releaseEligible,
    manifest, decisionVersion: decisions.at(-1)?.version ?? 0,
    decisions: decisions.map(({ version, action, actorId, selfConfirmed, decidedAt }) =>
      ({ version, action, actorId, selfConfirmed, decidedAt: decidedAt.toISOString() })),
    status, locale, message: translate(locale, `release.${status}`),
  });
}

// This slice has no public command binding or runtime consumer.
export class ReleaseCandidateService {
  constructor(private readonly database: Database, private readonly evidence: FixtureReleaseEvidence, private readonly humanClientId: string) {
    if (!humanClientId.trim() || humanClientId === 'signed-access-token') throw new Error('An explicit human OIDC client is required');
  }

  private async currentManifest(tx: Transaction, task: TaskScope) {
    const result = fixtureReleaseManifestSchema.safeParse(await this.evidence.readCurrent(tx, structuredClone(task.binding)));
    return result.success && matchesTask(result.data, task) ? result.data : undefined;
  }

  async freeze(rawTaskId: unknown) {
    const taskId = parseInput(idSchema, rawTaskId);
    return this.database.db.transaction(async tx => {
      const task = await lockTaskScope(tx, taskId, 'update');
      if (!task.waiting) throw new DomainError('unsupported_state');
      const manifest = await this.currentManifest(tx, task);
      if (!manifest) throw new DomainError('unsupported_state');
      const { applicationId, environmentId } = manifest.target;
      const [environment] = await tx.select({ id: environments.id }).from(environments)
        .where(and(eq(environments.id, environmentId), eq(environments.applicationId, applicationId),
          eq(environments.projectId, task.binding.projectId))).for('share');
      if (!environment) throw new DomainError('not_found');
      const sha = fingerprint(manifest);
      const latest = await latestCandidate(tx, taskId);
      if (latest && latest.evidenceVersion >= manifest.evidenceVersion) {
        if (latest.evidenceVersion === manifest.evidenceVersion && latest.fingerprint === sha) {
          return { id: latest.id, fingerprint: latest.fingerprint, releaseEligible: false as const, replayed: true };
        }
        throw new DomainError('version_conflict');
      }
      const now = await databaseNow(tx);
      if (Date.parse(manifest.validUntil) <= now.getTime()) throw new DomainError('unsupported_state');
      const id = randomUUID();
      await tx.insert(releaseCandidates).values({
        id, taskId, runId: task.binding.runId, projectId: task.binding.projectId, applicationId, environmentId,
        requestedBy: task.requestedBy, evidenceVersion: manifest.evidenceVersion, fingerprint: sha, document: manifest, createdAt: now,
      });
      return { id, fingerprint: sha, releaseEligible: false as const, replayed: false };
    });
  }

  async get(identity: VerifiedIdentity, rawCandidateId: unknown, locale: Locale = 'en') {
    const candidateId = parseInput(idSchema, rawCandidateId);
    return this.database.db.transaction(async tx => {
      const { candidate, project, task } = await this.visibleCandidate(tx, identity, candidateId, 'share');
      const { manifest, history, status, now } = await this.assess(tx, candidate, project.workspaceId, task);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');
      return present(candidate, manifest, history, status, locale);
    });
  }

  async decide(identity: VerifiedIdentity, rawCandidateId: unknown, raw: unknown, locale: Locale = 'en') {
    const candidateId = parseInput(idSchema, rawCandidateId);
    const input = parseInput(releaseDecisionInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const { actor, candidate, project, task, grantId } = await this.visibleCandidate(tx, identity, candidateId, 'update');
      if (!grantId) throw new DomainError('forbidden');
      if (candidate.fingerprint !== input.fingerprint) throw new DomainError('version_conflict');
      const { manifest, history, status, now } = await this.assess(tx, candidate, project.workspaceId, task);
      if (identity.expiresAt * 1_000 <= now.getTime()) throw new DomainError('unauthenticated');

      const replay = history.find(item => item.actorId === actor.principalId && item.idempotencyKey === input.idempotencyKey);
      if (replay) {
        if (replay.action !== input.action || replay.version !== input.expectedVersion + 1) throw new DomainError('idempotency_conflict');
        const [operation] = input.action === 'confirm'
          ? await tx.select({ id: releaseOperations.id }).from(releaseOperations).where(eq(releaseOperations.candidateId, candidate.id))
          : [];
        return { candidate: present(candidate, manifest, history, status, locale), operationId: operation?.id ?? null, replayed: true };
      }
      const decisionVersion = history.at(-1)?.version ?? 0;
      if (decisionVersion !== input.expectedVersion) throw new DomainError('version_conflict');
      if (input.action === 'revoke' ? status !== 'confirmed' : status !== 'pending') throw new DomainError('unsupported_state');
      const decision: DecisionRow = {
        candidateId, version: decisionVersion + 1, actorId: actor.principalId, grantId, idempotencyKey: input.idempotencyKey,
        action: input.action, selfConfirmed: input.action === 'confirm' && actor.principalId === candidate.requestedBy, decidedAt: now,
      };
      await tx.insert(releaseDecisions).values(decision);
      const operationId = decision.action === 'confirm' ? await enqueueReleaseOperation(tx, this.database, releaseFixtureQueue, {
        candidateId, environmentId: candidate.environmentId, approvalVersion: decision.version,
      }) : null;
      const decided = { confirm: 'confirmed', reject: 'rejected', revoke: 'revoked' } as const;
      return { candidate: present(candidate, manifest, [...history, decision], decided[input.action], locale), operationId, replayed: false };
    });
  }

  async lockFixtureApproval(tx: Transaction, candidate: CandidateRow, approvalVersion: number) {
    const [decision] = await tx.select().from(releaseDecisions).where(and(eq(releaseDecisions.candidateId, candidate.id),
      eq(releaseDecisions.version, approvalVersion), eq(releaseDecisions.action, 'confirm')));
    if (!decision) return;
    // Match the human command's lock order before latching the task.
    const approver = await requireStoredActor(tx, decision.actorId);
    if (!approver.workspaceId) return;
    const [project] = await tx.select({ workspaceId: projects.workspaceId }).from(projects)
      .where(and(eq(projects.id, candidate.projectId), eq(projects.workspaceId, approver.workspaceId))).for('share');
    if (!project) return;
    const task = await lockTaskScope(tx, candidate.taskId, 'share');
    const { manifest, status } = await this.assess(tx, candidate, project.workspaceId, task);
    return status === 'confirmed' ? manifest : undefined;
  }

  private async visibleCandidate(tx: Transaction, identity: VerifiedIdentity, candidateId: string, lock: 'share' | 'update') {
    const actor = await requireActor(tx, identity);
    const [candidate] = await tx.select().from(releaseCandidates).where(eq(releaseCandidates.id, candidateId));
    if (!candidate) throw new DomainError('not_found');
    const project = await requireProject(tx, actor, candidate.projectId);
    let grantId: string | undefined;
    if (lock === 'update') {
      if (actor.workspaceId !== project.workspaceId || identity.clientId !== this.humanClientId) throw new DomainError('forbidden');
      grantId = await ownerGrant(tx, project.workspaceId, actor.principalId);
      if (!grantId) throw new DomainError('forbidden');
    }
    const task = await lockTaskScope(tx, candidate.taskId, lock);
    return { actor, candidate, project, task, grantId };
  }

  private async assess(tx: Transaction, candidate: CandidateRow, workspaceId: string, task: TaskScope) {
    const manifest = parseFrozenRelease(candidate);
    const history = await tx.select().from(releaseDecisions).where(eq(releaseDecisions.candidateId, candidate.id)).orderBy(asc(releaseDecisions.version));
    const last = history.at(-1);
    let status: ReleaseCandidateStatus;
    if (last?.action === 'revoke') status = 'revoked';
    else if (last?.action === 'reject') status = 'rejected';
    else if (!matchesTask(manifest, task) || candidate.requestedBy !== task.requestedBy) status = 'task_changed';
    else if ((await latestCandidate(tx, candidate.taskId))?.id !== candidate.id) status = 'superseded';
    else {
      const current = await this.currentManifest(tx, task);
      if (!current || fingerprint(current) !== candidate.fingerprint) status = 'evidence_changed';
      else if (last && await ownerGrant(tx, workspaceId, last.actorId) !== last.grantId) status = 'approver_revoked';
      else status = last ? 'confirmed' : 'pending';
    }
    // Capture time only after locking the task, evidence and live authorization.
    const now = await databaseNow(tx);
    if ((status === 'pending' || status === 'confirmed') && Date.parse(manifest.validUntil) <= now.getTime()) status = 'expired';
    return { manifest, history, status, now };
  }
}
