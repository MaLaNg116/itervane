import { randomUUID } from 'node:crypto';
import {
  formalReleaseCandidateDtoSchema, formalReleaseManifestSchema, freezeFormalReleaseSchema, idSchema,
  standardVerificationProfileSchema, translate, type FormalReleaseManifest, type Locale,
} from '@itervane/contracts';
import { sha256 } from '@itervane/runner';
import { and, desc, eq } from 'drizzle-orm';
import type { VerifiedIdentity } from '../auth/identity.js';
import type { Database } from '../persistence/database.js';
import { environments, formalReleaseTargets, releaseCandidates, runRuntime, taskRuns, tasks } from '../persistence/schema.js';
import { appendEvent } from '../runtime/authority.js';
import { requireActor, requireProject, requireStoredActor, type Transaction } from './access.js';
import { DomainError, parseInput } from './errors.js';
import { readReleaseTarget } from './release-targets.js';
import { databaseNow } from './releases.js';
import { readPublishedVerification } from './verification-result.js';

type Candidate = typeof releaseCandidates.$inferSelect;
type CandidateStatus = ReturnType<typeof formalReleaseCandidateDtoSchema.parse>['status'];

async function visibleTask(tx: Transaction, identity: VerifiedIdentity, taskId: string, write = false) {
  const actor = await requireActor(tx, identity);
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for(write ? 'update' : 'share');
  if (!task) throw new DomainError('not_found');
  await requireProject(tx, actor, task.projectId, write);
  return { actor, task };
}

async function latestCandidate(tx: Transaction, taskId: string) {
  return (await tx.select().from(releaseCandidates).where(eq(releaseCandidates.taskId, taskId))
    .orderBy(desc(releaseCandidates.evidenceVersion)).limit(1))[0];
}

function readCandidate(row: Candidate) {
  const document = formalReleaseManifestSchema.parse(row.document);
  if (sha256(JSON.stringify(document)) !== row.fingerprint || document.taskId !== row.taskId || document.runId !== row.runId
      || document.projectId !== row.projectId || document.evidenceVersion !== row.evidenceVersion
      || document.target.applicationId !== row.applicationId || document.target.environmentId !== row.environmentId) {
    throw new Error('formal_release_candidate_integrity');
  }
  return document;
}

function present(row: Candidate, manifest: FormalReleaseManifest, status: CandidateStatus, locale: Locale) {
  return formalReleaseCandidateDtoSchema.parse({ id: row.id, fingerprint: row.fingerprint, manifest, status, locale,
    createdAt: row.createdAt.toISOString(),
    message: translate(locale, status === 'pending' ? 'task.release_candidate_frozen' : `release.${status}`),
  });
}

export class FormalReleaseService {
  constructor(private readonly database: Database) {}

  async freeze(identity: VerifiedIdentity, taskId: string, raw: unknown, locale: Locale) {
    parseInput(idSchema, taskId);
    const { environmentId, expectedVersion } = parseInput(freezeFormalReleaseSchema, raw);
    return this.database.db.transaction(async tx => {
      const { actor, task } = await visibleTask(tx, identity, taskId, true);
      await requireProject(tx, await requireStoredActor(tx, task.requestedBy), task.projectId, true);
      const [run] = await tx.select({ runId: taskRuns.id, generation: taskRuns.generation, state: taskRuns.state, reason: runRuntime.reason })
        .from(taskRuns).innerJoin(runRuntime, eq(runRuntime.runId, taskRuns.id))
        .where(and(eq(taskRuns.taskId, task.id), eq(taskRuns.generation, task.generation)));
      if (!run || run.state !== task.state || !((task.state === 'waiting_input' && run.reason === 'verification_observed')
          || (task.state === 'waiting_approval' && run.reason === 'release_candidate_ready'))) throw new DomainError('unsupported_state');

      const [environment] = await tx.select({ id: environments.id }).from(environments).where(and(eq(environments.id, environmentId),
        eq(environments.projectId, task.projectId))).for('share');
      if (!environment) throw new DomainError('not_found');
      const [target] = await tx.select().from(formalReleaseTargets).where(and(eq(formalReleaseTargets.environmentId, environmentId),
        eq(formalReleaseTargets.projectId, task.projectId))).for('share');
      if (!target) throw new DomainError('not_found');
      const mapping = readReleaseTarget(target);
      const verification = await readPublishedVerification(tx, task, run);
      if (!verification) throw new DomainError('unsupported_state');
      const { row, input, result, evidence } = verification;
      const { source, build, baseline, image } = evidence;
      const profile = standardVerificationProfileSchema.safeParse(input.profile);
      if (!profile.success || sha256(JSON.stringify(profile.data)) !== mapping.verificationProfileSha256
          || result.review?.outcome !== 'observed' || !result.archiveVerification
          || source.status !== 'compared' || source.introduced !== 0 || source.remaining !== 0
          || build.status !== 'built' || baseline.status !== 'passed' || image.status !== 'scanned'
          || mapping.blockImageSeverities.some(severity => image.findings[severity] > 0)) throw new DomainError('unsupported_state');

      const previous = await latestCandidate(tx, taskId);
      const now = await databaseNow(tx);
      if (identity.expiresAt * 1000 <= now.getTime()) throw new DomainError('unauthenticated');
      const expiresAt = Math.min(now.getTime() + mapping.approvalTtlSeconds * 1000,
        row.createdAt.getTime() + mapping.verificationMaxAgeSeconds * 1000);
      if (expiresAt <= now.getTime()) throw new DomainError('unsupported_state');

      const basis = {
        version: 1, origin: 'formal_verification', releaseEligible: false,
        taskId, runId: run.runId, projectId: task.projectId, generation: run.generation, source: input.source,
        originalSnapshotSha256: input.inspection.snapshotSha256, repairedSnapshotSha256: input.subject.manifestSha256,
        diffSha256: input.subject.kind === 'repair' ? input.subject.patchSha256 : null,
        verification: { inputSha256: row.inputSha256, resultSha256: row.sha256, receiptSha256: row.receiptSha256,
          catalogSha256: input.catalogSha256, profileSha256: mapping.verificationProfileSha256, buildSha256: build.distSha256,
          baselineSha256: baseline.baselineSha256, source: { introduced: source.introduced, resolved: source.resolved, remaining: source.remaining },
        },
        image: { manifestDigest: image.manifestDigest, configDigest: image.configDigest, archive: result.archiveVerification.archive,
          runnerImageSha256: result.archiveVerification.runnerImageSha256, scanReportSha256: image.scanReportSha256,
          scanPolicySha256: image.scanPolicySha256, findings: image.findings,
        },
        runtimeConfigSha256: mapping.runtimeConfigSha256, rolloutCheckSha256: mapping.rolloutCheckSha256, recoveryPlanSha256: mapping.recoveryPlanSha256,
        target: { applicationId: target.applicationId, environmentId, mappingSha256: target.sha256, revision: target.revision },
      };
      if (previous?.document.origin === 'formal_verification') {
        const existing = readCandidate(previous);
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
      const row = await latestCandidate(tx, taskId);
      if (row?.document.origin !== 'formal_verification') throw new DomainError('not_found');
      const manifest = readCandidate(row);
      const [target] = await tx.select().from(formalReleaseTargets).where(eq(formalReleaseTargets.environmentId, row.environmentId)).for('share');
      if (target) readReleaseTarget(target);
      const now = await databaseNow(tx);
      if (identity.expiresAt * 1000 <= now.getTime()) throw new DomainError('unauthenticated');
      const status = task.generation !== manifest.generation || task.state !== 'waiting_approval' ? 'task_changed'
        : target?.sha256 !== manifest.target.mappingSha256 || target.revision !== manifest.target.revision ? 'evidence_changed'
        : Date.parse(manifest.validUntil) <= now.getTime() ? 'expired' : 'pending';
      return present(row, manifest, status, locale);
    });
  }
}
