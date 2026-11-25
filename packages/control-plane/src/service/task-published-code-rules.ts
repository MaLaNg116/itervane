import { and, eq } from 'drizzle-orm';
import type { CodeRuleValidationProfile, PublishedCodeRuleSet } from '@itervane/contracts';
import { projects, rulePackageActivations, rulePackageReviews, rulePackageVersions } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { readPassedCandidateValidation } from './candidate-validations.js';
import { readRulePackageDocument, readRulePackageReview } from './rule-packages.js';
import { readTaskRuleSnapshot } from './task-rule-snapshots.js';

/** Loads the past activation rows named by the task, including versions subsequently rolled back. */
export async function readTaskPublishedCodeRules(tx: Transaction, task: { id: string; projectId: string },
  profile?: CodeRuleValidationProfile): Promise<PublishedCodeRuleSet | null> {
  const pinned = await readTaskRuleSnapshot(tx, task);
  if (!pinned || pinned.document.purpose !== 'delivery') return null;
  const entries = pinned.document.entries.filter(entry => entry.kind === 'code_rule');
  if (!entries.length) return null;
  if (!profile) throw new Error('published_inspection_profile_unavailable');
  const [project] = await tx.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, task.projectId));
  if (!project) throw new Error('task_published_code_scope');
  const rules: PublishedCodeRuleSet['rules'] = [];
  for (const entry of entries) {
    const [row] = await tx.select({ activation: rulePackageActivations, version: rulePackageVersions, review: rulePackageReviews })
      .from(rulePackageActivations)
      .innerJoin(rulePackageVersions, and(eq(rulePackageVersions.id, rulePackageActivations.versionId),
        eq(rulePackageVersions.packageId, rulePackageActivations.packageId), eq(rulePackageVersions.workspaceId, project.workspaceId)))
      .innerJoin(rulePackageReviews, and(eq(rulePackageReviews.id, rulePackageActivations.reviewId),
        eq(rulePackageReviews.versionId, rulePackageVersions.id)))
      .where(and(eq(rulePackageActivations.packageId, entry.packageId), eq(rulePackageActivations.sequence, entry.sequence)));
    if (!row || row.activation.action === 'withdraw' || row.version.id !== entry.versionId || row.version.packageKey !== entry.packageKey
        || row.version.sha256 !== entry.versionSha256 || row.activation.versionSha256 !== entry.versionSha256
        || row.review.sha256 !== entry.reviewSha256 || row.activation.reviewSha256 !== entry.reviewSha256) {
      throw new Error('task_published_code_activation');
    }
    const document = readRulePackageDocument(row.version);
    const review = readRulePackageReview(row.review, row.version);
    if (document.kind !== 'code_rule' || review.outcome !== 'accepted'
        || (document.scope.kind === 'project' && document.scope.projectId !== task.projectId)) throw new Error('task_published_code_scope');
    const { projectId, candidateId, id } = document.validation;
    const { validation, record } = await readPassedCandidateValidation(tx, projectId, candidateId, id);
    if (JSON.stringify(validation) !== JSON.stringify(document.validation)) throw new Error('task_published_code_validation');
    rules.push({ package: document, review, validation: record });
  }
  return { version: 1, snapshot: { sha256: pinned.sha256, document: pinned.document }, profile, rules };
}
