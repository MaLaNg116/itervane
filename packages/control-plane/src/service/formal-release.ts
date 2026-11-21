import { randomUUID } from 'node:crypto';
import {
  formalReleaseCandidateDtoSchema, formalReleaseManifestSchema, formalReleaseViewSchema, freezeFormalReleaseSchema, idSchema,
  komodoReleasePhases, releaseDecisionInputSchema,
  standardVerificationProfileSchema, translate, type FormalReleaseCandidateDto, type FormalReleaseManifest, type FormalReleaseTarget,
  type FormalVerificationResult, type Locale, type ReleaseDecision,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import { formalReleaseQueue, type Database } from '../persistence/database.js';
import { applications, environments, formalReleaseTargets, formalVerificationInputs, formalVerificationResults, releaseCandidates,
  releaseDecisions, releaseOperations, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { appendEvent, type TaskRow } from '../runtime/authority.js';
import { blockQueuedRelease, enqueueReleaseOperation } from '../runtime/release-queue.js';
import { requireActor, requireProject, requireProjectAccess, requireStoredActor, type Actor, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readReleaseTarget } from './release-targets.js';
import { databaseNow } from './releases.js';
import { readPublishedVerification } from './verification-result.js';

type Candidate = typeof releaseCandidates.$inferSelect;
type Decision = typeof releaseDecisions.$inferSelect;
type CandidateStatus = ReturnType<typeof formalReleaseCandidateDtoSchema.parse>['status'];
type CandidateProgress = 'task.release_claimed' | 'task.release_registry_uncertain' | `task.${typeof komodoReleasePhases[number]}`;

async function visibleTask(tx: Transaction, identity: VerifiedIdentity, taskId: string, write = false) {
  const actor = await requireActor(tx, identity);
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for(write ? 'update' : 'share');
  if (!task) throw new DomainError('not_found');
  const { project, role } = await requireProjectAccess(tx, actor, task.projectId, write);
  return { actor, task, project, role };
}

async function currentRun(tx: Transaction, task: TaskRow) {
  return (await tx.select({ runId: taskRuns.id, generation: taskRuns.generation, state: taskRuns.state, reason: runRuntime.reason })
    .from(taskRuns).innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
    .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation))))[0];
}

function canPrepare(task: TaskRow, run: NonNullable<Awaited<ReturnType<typeof currentRun>>>) {
  return run.state === task.state && ((task.state === 'waiting_input' && run.reason === 'verification_observed')
    || (task.state === 'waiting_approval' && run.reason === 'release_candidate_ready'));
}

function releaseEvidence(result: FormalVerificationResult, rawProfile: unknown, mapping: FormalReleaseTarget) {
  const profile = standardVerificationProfileSchema.safeParse(rawProfile);
  const { source, build, baseline, image } = result.evidence;
  if (!profile.success || sha256(JSON.stringify(profile.data)) !== mapping.verificationProfileSha256
      || result.review?.outcome !== 'observed' || !result.archiveVerification
      || source.status !== 'compared' || source.introduced !== 0 || source.remaining !== 0
      || build.status !== 'built' || baseline.status !== 'passed' || image.status !== 'scanned'
      || mapping.blockImageSeverities.some(severity => image.findings[severity] > 0)) return null;
  return { source, build, baseline, image, archiveVerification: result.archiveVerification };
}

async function requesterCanWrite(tx: Transaction, task: TaskRow) {
  try {
    await requireProject(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true);
    return true;
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'not_found' || error.code === 'forbidden')) return false;
    throw error;
  }
}

export function describeVerifiedRelease(verification: NonNullable<Awaited<ReturnType<typeof readPublishedVerification>>>,
  target: typeof formalReleaseTargets.$inferSelect, mapping: FormalReleaseTarget) {
  const { row, input, result } = verification;
  const evidence = releaseEvidence(result, input.profile, mapping);
  if (!evidence) return null;
  const { source, build, baseline, image, archiveVerification } = evidence;
  const manifest = {
    version: 1, origin: 'formal_verification', releaseEligible: false,
    taskId: input.taskId, runId: input.runId, projectId: input.projectId, generation: input.generation, source: input.source,
    originalSnapshotSha256: input.inspection.snapshotSha256, repairedSnapshotSha256: input.subject.manifestSha256,
    diffSha256: input.subject.kind === 'repair' ? input.subject.patchSha256 : null,
    verification: { inputSha256: row.inputSha256, resultSha256: row.sha256, receiptSha256: row.receiptSha256,
      catalogSha256: input.catalogSha256, profileSha256: mapping.verificationProfileSha256, buildSha256: build.distSha256,
      baselineSha256: baseline.baselineSha256, source: { introduced: source.introduced, resolved: source.resolved, remaining: source.remaining },
    },
    image: { manifestDigest: image.manifestDigest, configDigest: image.configDigest, archive: archiveVerification.archive,
      runnerImageSha256: archiveVerification.runnerImageSha256, scanReportSha256: image.scanReportSha256,
      scanPolicySha256: image.scanPolicySha256, findings: image.findings,
    },
    runtimeConfigSha256: mapping.runtimeConfigSha256, rolloutCheckSha256: mapping.rolloutCheckSha256, recoveryPlanSha256: mapping.recoveryPlanSha256,
    target: { applicationId: target.applicationId, environmentId: target.environmentId, mappingSha256: target.sha256, revision: target.revision },
  };
  return { manifest, archiveVerification };
}

export async function latestReleaseCandidate(tx: Transaction, taskId: string) {
  return (await tx.select().from(releaseCandidates).where(eq(releaseCandidates.taskId, taskId))
    .orderBy(desc(releaseCandidates.evidenceVersion)).limit(1))[0];
}

export function readReleaseManifest(row: Candidate) {
  const document = formalReleaseManifestSchema.parse(row.document);
  if (sha256(JSON.stringify(document)) !== row.fingerprint || document.taskId !== row.taskId || document.runId !== row.runId
      || document.projectId !== row.projectId || document.evidenceVersion !== row.evidenceVersion
      || document.target.applicationId !== row.applicationId || document.target.environmentId !== row.environmentId) {
    throw new Error('formal_release_candidate_integrity');
  }
  return document;
}

const decisionEvents = { confirm: 'task.release_confirmed', reject: 'task.release_rejected', revoke: 'task.release_revoked' } as const;
const decisionStatuses = { confirm: 'confirmed', reject: 'rejected', revoke: 'revoked' } as const;
const decisionMessages = { pending: 'task.release_candidate_frozen', confirmed: decisionEvents.confirm,
  rejected: decisionEvents.reject, revoked: decisionEvents.revoke,
} as const;

function present(row: Candidate, manifest: FormalReleaseManifest, status: CandidateStatus, locale: Locale,
  history: Decision[] = [], operationId: string | null = null, progress?: CandidateProgress) {
  const message = status === 'confirmed' && progress ? progress
    : (status === 'pending' || status === 'confirmed' || status === 'rejected' || status === 'revoked'
      ? decisionMessages[status] : `release.${status}` as const);
  return formalReleaseCandidateDtoSchema.parse({ id: row.id, fingerprint: row.fingerprint, manifest, status, locale,
    createdAt: row.createdAt.toISOString(), message: translate(locale, message), operationId,
    decisionVersion: history.at(-1)?.version ?? 0,
    decisions: history.map(({ version, action, actorId, selfConfirmed, decidedAt }) => ({ version, action, actorId, selfConfirmed, decidedAt: decidedAt.toISOString() })),
  });
}

async function assessCandidate(tx: Transaction, task: TaskRow, row: Candidate, manifest: FormalReleaseManifest) {
  const history = await tx.select().from(releaseDecisions).where(eq(releaseDecisions.candidateId, row.id)).orderBy(asc(releaseDecisions.version));
  const last = history.at(-1);
  const [operation] = await tx.select().from(releaseOperations).where(eq(releaseOperations.candidateId, row.id));
  const [runtime] = await tx.select({ reason: runRuntime.reason }).from(runRuntime).where(eq(runRuntime.runId, row.runId));
  const komodoPhase = komodoReleasePhases.find(phase => phase === runtime?.reason);
  const claimed = operation?.state === 'dispatching'
    && (komodoPhase !== undefined || ['release_claimed', 'release_registry_prepared', 'release_registry_verified'].includes(runtime?.reason ?? ''))
    && (task.state === 'running' || task.state === 'cancel_requested');
  const observing = operation?.state === 'reconciling' && (komodoPhase !== undefined || runtime?.reason === 'release_registry_reconciling')
    && ['running', 'reconciling', 'cancel_requested'].includes(task.state);
  const dispatchPhase = komodoPhase ? `task.${komodoPhase}` as const : 'task.release_claimed';
  let progress: CandidateProgress | undefined;
  if (claimed || (observing && komodoPhase)) progress = dispatchPhase;
  else if (observing) progress = 'task.release_registry_uncertain';
  const queued = operation?.state === 'queued' && task.state === 'queued' && runtime?.reason === 'release_queued';
  const active = task.generation === manifest.generation && task.requestedBy === row.requestedBy && (last?.action === 'confirm'
    ? queued || claimed || observing
    : task.state === 'waiting_approval' && runtime?.reason === 'release_candidate_ready');
  let status: CandidateStatus;
  if (last?.action === 'revoke') status = 'revoked';
  else if (last?.action === 'reject') status = 'rejected';
  else if (!active) status = 'task_changed';
  else if ((await latestReleaseCandidate(tx, task.id))?.id !== row.id) status = 'superseded';
  else {
    await tx.select({ id: environments.id }).from(environments).where(eq(environments.id, row.environmentId)).for('share');
    const [target] = await tx.select().from(formalReleaseTargets).where(eq(formalReleaseTargets.environmentId, row.environmentId)).for('share');
    if (target) readReleaseTarget(target);
    if (target?.sha256 !== manifest.target.mappingSha256 || target.revision !== manifest.target.revision) status = 'evidence_changed';
    else if (last?.action === 'confirm' && (await requireStoredActor(tx, last.actorId)).workspaceGrantId !== last.grantId) status = 'approver_revoked';
    else status = last ? 'confirmed' : 'pending';
  }
  const now = await databaseNow(tx);
  if ((status === 'pending' || status === 'confirmed') && Date.parse(manifest.validUntil) <= now.getTime()) status = 'expired';
  return { status, history, operation, progress, active, now };
}

async function readLatestFormalCandidate(tx: Transaction, task: TaskRow, locale: Locale) {
  const row = await latestReleaseCandidate(tx, task.id);
  if (row?.document.origin !== 'formal_verification') return null;
  const manifest = readReleaseManifest(row);
  const assessment = await assessCandidate(tx, task, row, manifest);
  return { ...assessment, view: present(row, manifest, assessment.status, locale, assessment.history, assessment.operation?.id, assessment.progress) };
}

function queuedConfirmation({ active, history, operation }: Awaited<ReturnType<typeof assessCandidate>>) {
  return active && history.at(-1)?.action === 'confirm' && operation?.state === 'queued' ? operation : null;
}

const targetDisplay = {
  applicationId: applications.id, applicationName: applications.name,
  environmentId: environments.id, environmentName: environments.name,
};

export class FormalReleaseService {
  constructor(private readonly database: Database, private readonly humanClientId?: string) {}

  private canDecide(identity: VerifiedIdentity, actor: Actor, workspaceId: string): actor is Actor & { workspaceGrantId: string } {
    return !!this.humanClientId && this.humanClientId !== 'signed-access-token' && identity.clientId === this.humanClientId
      && actor.workspaceId === workspaceId && actor.workspaceGrantId !== null;
  }

  async freeze(identity: VerifiedIdentity, taskId: string, raw: unknown, locale: Locale) {
    parseInput(idSchema, taskId);
    const { environmentId, expectedVersion } = parseInput(freezeFormalReleaseSchema, raw);
    return this.database.db.transaction(async tx => {
      const { actor, task } = await visibleTask(tx, identity, taskId, true);
      await requireProject(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true);
      const run = await currentRun(tx, task);
      if (!run || !canPrepare(task, run)) throw new DomainError('unsupported_state');

      const [environment] = await tx.select({ id: environments.id }).from(environments).where(and(eq(environments.id, environmentId),
        eq(environments.projectId, task.projectId))).for('share');
      if (!environment) throw new DomainError('not_found');
      const [target] = await tx.select().from(formalReleaseTargets).where(and(eq(formalReleaseTargets.environmentId, environmentId),
        eq(formalReleaseTargets.projectId, task.projectId))).for('share');
      if (!target) throw new DomainError('not_found');
      const mapping = readReleaseTarget(target);
      const verification = await readPublishedVerification(tx, task, run);
      if (!verification) throw new DomainError('unsupported_state');
      const evidence = describeVerifiedRelease(verification, target, mapping);
      if (!evidence) throw new DomainError('unsupported_state');
      const { manifest: basis } = evidence;

      const previous = await latestReleaseCandidate(tx, taskId);
      const now = await databaseNow(tx);
      if (identity.expiresAt * 1000 <= now.getTime()) throw new DomainError('unauthenticated');
      const expiresAt = Math.min(now.getTime() + mapping.approvalTtlSeconds * 1000,
        verification.row.createdAt.getTime() + mapping.verificationMaxAgeSeconds * 1000);
      if (expiresAt <= now.getTime()) throw new DomainError('unsupported_state');

      if (previous?.document.origin === 'formal_verification') {
        const existing = readReleaseManifest(previous);
        const repeated = formalReleaseManifestSchema.parse({ ...basis, evidenceVersion: previous.evidenceVersion, validUntil: existing.validUntil });
        if (Date.parse(existing.validUntil) > now.getTime() && sha256(JSON.stringify(repeated)) === previous.fingerprint) {
          if (expectedVersion !== task.version && expectedVersion !== task.version - 1) throw new DomainError('version_conflict');
          return { candidate: present(previous, existing, 'pending', locale), replayed: true };
        }
      }
      if (task.version !== expectedVersion) throw new DomainError('version_conflict');
      const document = formalReleaseManifestSchema.parse({ ...basis, evidenceVersion: (previous?.evidenceVersion ?? 0) + 1,
        validUntil: new Date(expiresAt).toISOString() });
      const fingerprint = sha256(JSON.stringify(document));
      const [candidate] = await tx.insert(releaseCandidates).values({ id: randomUUID(), taskId, runId: run.runId,
        projectId: task.projectId, applicationId: target.applicationId, environmentId, requestedBy: task.requestedBy,
        evidenceVersion: document.evidenceVersion, fingerprint, document, createdAt: now,
      }).returning();
      await tx.update(runRuntime).set({ reason: 'release_candidate_ready' }).where(eq(runRuntime.runId, run.runId));
      await appendEvent(tx, task, 'task.release_candidate_frozen', 'waiting_approval', { actorId: actor.principalId,
        reason: 'release_candidate_ready', releaseCandidate: { candidateId: candidate!.id, fingerprint },
      });
      return { candidate: present(candidate!, document, 'pending', locale), replayed: false };
    });
  }

  async get(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const { task } = await visibleTask(tx, identity, taskId);
      const candidate = await readLatestFormalCandidate(tx, task, locale);
      if (!candidate) throw new DomainError('not_found');
      if (identity.expiresAt * 1000 <= candidate.now.getTime()) throw new DomainError('unauthenticated');
      return candidate.view;
    });
  }

  async getView(identity: VerifiedIdentity, taskId: string, locale: Locale) {
    parseInput(idSchema, taskId);
    return this.database.db.transaction(async tx => {
      const { actor, task, project, role } = await visibleTask(tx, identity, taskId);
      const run = await currentRun(tx, task);
      if (!run) throw new DomainError('not_found');
      const assessment = await readLatestFormalCandidate(tx, task, locale);
      const candidate = assessment?.view ?? null;
      const target = candidate?.manifest.target;
      const [candidateTarget] = target ? await tx.select(targetDisplay).from(environments)
        .innerJoin(applications, eq(applications.id, environments.applicationId))
        .where(and(eq(environments.id, target.environmentId), eq(environments.projectId, task.projectId),
          eq(applications.id, target.applicationId))) : [];
      const mayPrepare = (role === 'owner' || role === 'maintainer') && canPrepare(task, run);
      const mayDecide = assessment !== null && this.canDecide(identity, actor, project.workspaceId);
      const requesterAuthorized = (mayPrepare || (mayDecide && candidate?.status === 'pending')) && await requesterCanWrite(tx, task);
      const actions: ReleaseDecision[] = [];
      if (mayDecide && candidate?.status === 'pending') {
        if (requesterAuthorized) actions.push('confirm');
        actions.push('reject');
      }
      if (mayDecide && assessment && queuedConfirmation(assessment)) actions.push('revoke');
      const availableTargets = mayPrepare && requesterAuthorized ? await this.availableTargets(tx, task, run.runId, candidate) : [];
      if (identity.expiresAt * 1000 <= (await databaseNow(tx)).getTime()) throw new DomainError('unauthenticated');
      return formalReleaseViewSchema.parse({
        taskId, runId: run.runId, taskVersion: task.version, candidate, candidateTarget: candidateTarget ?? null, availableTargets, actions,
      });
    });
  }

  private async availableTargets(tx: Transaction, task: TaskRow, runId: string, candidate: FormalReleaseCandidateDto | null) {
    // The immutable result is bounded. A preparation command still rereads and binds the full Runner receipt.
    const [proof] = await tx.select({ result: formalVerificationResults.document, createdAt: formalVerificationResults.createdAt,
      profile: sql<unknown>`${formalVerificationInputs.document}->'profile'` }).from(formalVerificationResults)
      .innerJoin(formalVerificationInputs, eq(formalVerificationInputs.runId, formalVerificationResults.runId))
      .where(eq(formalVerificationResults.runId, runId));
    if (!proof?.result.archiveVerification) return [];
    const targets = await tx.select({ display: targetDisplay, row: formalReleaseTargets }).from(formalReleaseTargets)
      .innerJoin(environments, eq(environments.id, formalReleaseTargets.environmentId))
      .innerJoin(applications, eq(applications.id, formalReleaseTargets.applicationId))
      .where(eq(formalReleaseTargets.projectId, task.projectId)).orderBy(asc(applications.name), asc(environments.name));
    const now = (await databaseNow(tx)).getTime();
    return targets.flatMap(({ display, row }) => {
      const mapping = readReleaseTarget(row);
      const alreadyPending = candidate?.status === 'pending' && candidate.manifest.target.environmentId === row.environmentId
        && candidate.manifest.target.revision === row.revision;
      if (alreadyPending || proof.createdAt.getTime() + mapping.verificationMaxAgeSeconds * 1000 <= now
          || !releaseEvidence(proof.result, proof.profile, mapping)) return [];
      return [{ ...display, revision: row.revision }];
    });
  }

  async decide(identity: VerifiedIdentity, rawCandidateId: string, raw: unknown, locale: Locale) {
    const candidateId = parseInput(idSchema, rawCandidateId);
    const input = parseInput(releaseDecisionInputSchema, raw);
    return this.database.db.transaction(async tx => {
      const [row] = await tx.select().from(releaseCandidates).where(eq(releaseCandidates.id, candidateId));
      if (row?.document.origin !== 'formal_verification') throw new DomainError('not_found');
      const { actor, task, project } = await visibleTask(tx, identity, row.taskId, true);
      if (!this.canDecide(identity, actor, project.workspaceId)) throw new DomainError('forbidden');
      if (row.fingerprint !== input.fingerprint) throw new DomainError('version_conflict');
      const manifest = readReleaseManifest(row);
      const assessment = await assessCandidate(tx, task, row, manifest);
      const { status, history, operation, progress, now } = assessment;
      if (identity.expiresAt * 1000 <= now.getTime()) throw new DomainError('unauthenticated');
      const duplicate = history.find(item => item.actorId === actor.principalId && item.idempotencyKey === input.idempotencyKey);
      if (duplicate) {
        if (duplicate.action !== input.action || duplicate.version !== input.expectedVersion + 1) throw new DomainError('idempotency_conflict');
        return { candidate: present(row, manifest, status, locale, history, operation?.id, progress), replayed: true };
      }
      const version = history.at(-1)?.version ?? 0;
      if (input.expectedVersion !== version) throw new DomainError('version_conflict');
      if (input.action === 'revoke') {
        const queued = queuedConfirmation(assessment);
        if (!queued || !await blockQueuedRelease(tx, this.database, queued.id, now)) throw new DomainError('unsupported_state');
      } else if (status !== 'pending') throw new DomainError('unsupported_state');

      if (input.action === 'confirm') {
        await requireProject(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true);
        const verification = await readPublishedVerification(tx, task, { runId: row.runId, generation: task.generation });
        if (!verification?.result.archiveVerification || verification.row.sha256 !== manifest.verification.resultSha256
            || verification.row.receiptSha256 !== manifest.verification.receiptSha256) throw new DomainError('unsupported_state');
      }
      const decidedAt = await databaseNow(tx);
      if (identity.expiresAt * 1000 <= decidedAt.getTime()) throw new DomainError('unauthenticated');
      if (input.action !== 'revoke' && Date.parse(manifest.validUntil) <= decidedAt.getTime()) throw new DomainError('unsupported_state');
      const decision: Decision = { candidateId, version: version + 1, actorId: actor.principalId, grantId: actor.workspaceGrantId,
        idempotencyKey: input.idempotencyKey, action: input.action, decidedAt,
        selfConfirmed: input.action === 'confirm' && actor.principalId === row.requestedBy,
      };
      await tx.insert(releaseDecisions).values(decision);
      const operationId = input.action === 'confirm' ? await enqueueReleaseOperation(tx, this.database, formalReleaseQueue, {
        candidateId, environmentId: row.environmentId, approvalVersion: decision.version,
      }) : operation?.id;
      if (input.action === 'confirm') await tx.update(taskRuns).set({ wakeupJobId: null }).where(eq(taskRuns.id, row.runId));
      await tx.update(runRuntime).set({ reason: input.action === 'confirm' ? 'release_queued' : null }).where(eq(runRuntime.runId, row.runId));
      await appendEvent(tx, task, decisionEvents[input.action], input.action === 'confirm' ? 'queued' : 'needs_human', {
        actorId: actor.principalId, ...(input.action === 'confirm' ? { reason: 'release_queued' as const } : {}),
        releaseDecision: { candidateId, fingerprint: row.fingerprint, decisionVersion: decision.version, ...(operationId ? { operationId } : {}) },
      });
      return { candidate: present(row, manifest, decisionStatuses[input.action], locale, [...history, decision], operationId), replayed: false };
    });
  }
}
