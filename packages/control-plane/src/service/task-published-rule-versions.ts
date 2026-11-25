import { and, eq } from 'drizzle-orm';
import type { TaskRuleSnapshot } from '@itervane/contracts';
import { projects, rulePackageActivations, rulePackageReviews, rulePackageVersions } from '../persistence/schema.js';
import type { Transaction } from './access.js';
import { readPassedCandidateValidation } from './candidate-validations.js';
import { readRulePackageDocument, readRulePackageReview } from './rule-packages.js';

/** Resolves immutable package content and the review identified by an authorized task reference. */
export async function readPinnedRuleVersions(tx: Transaction, task: { projectId: string }, entries: TaskRuleSnapshot['entries']) {
  if (!entries.length) return [];
  const [project] = await tx.select({ workspaceId: projects.workspaceId }).from(projects).where(eq(projects.id, task.projectId));
  if (!project) throw new Error('task_pinned_rule_scope');
  const rules = [];
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
      throw new Error('task_pinned_rule_activation');
    }
    const document = readRulePackageDocument(row.version);
    const review = readRulePackageReview(row.review, row.version);
    if (document.kind !== entry.kind || review.kind !== (document.kind === 'design_skill' ? 'design_review' : 'candidate_review') || review.outcome !== 'accepted'
        || (document.scope.kind === 'project' && document.scope.projectId !== task.projectId)) throw new Error('task_pinned_rule_scope');
    rules.push({ entry, document, review });
  }
  return rules;
}

export async function readPinnedValidatedRules(tx: Transaction, task: { projectId: string }, entries: TaskRuleSnapshot['entries']) {
  const rules = [];
  for (const { entry, document, review } of await readPinnedRuleVersions(tx, task, entries)) {
    if (document.kind === 'design_skill') throw new Error('task_pinned_rule_validation_kind');
    const { projectId, candidateId, id } = document.validation;
    const { validation, record, candidate } = await readPassedCandidateValidation(tx, projectId, candidateId, id);
    if (JSON.stringify(validation) !== JSON.stringify(document.validation) || JSON.stringify(candidate) !== JSON.stringify(document.candidate)) {
      throw new Error('task_pinned_rule_validation');
    }
    rules.push({ entry, document, review, record });
  }
  return rules;
}
