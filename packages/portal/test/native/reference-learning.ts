import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import type { Page } from '@playwright/test';
import {
  admissionDtoSchema, candidateValidationViewSchema, learningCaseCaptureResultSchema, ruleExtractionViewSchema,
  rulePackageActivationResultSchema, rulePackageImportResultSchema, type OperationsRunbookBinding,
} from '@itervane/contracts';
import { portalPost, untilResult } from './reference-browser.js';

export type ReferenceRule = Pick<OperationsRunbookBinding['selection']['rule'], 'packageId' | 'packageKey' | 'versionId' | 'versionSha256' | 'sequence'> & {
  reviewSha256: string;
  validationSha256: string;
};

export async function publishReferenceRule(input: {
  page: Page; client: Client; origin: string; projectId: string; taskId: string; runId: string; evidenceSha256: string;
  kind: 'runbook' | 'code_rule';
}) {
  const { page, client, origin, projectId, taskId, runId, evidenceSha256, kind } = input;
  const taskPath = '/v1/tasks/' + taskId;
  await page.bringToFront();
  const observedRequest = await page.waitForRequest(origin + taskPath);
  const authorization = await observedRequest.headerValue('authorization');
  ok(authorization && authorization.startsWith('Bearer '));
  const post = async (path: string, document: object, status: number) => {
    const response = await fetch(origin + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Accept-Language': 'en' },
      body: JSON.stringify(document),
    });
    equal(response.status, status);
    return response.json() as Promise<unknown>;
  };
  const reading = async (name: string, id: string) => {
    const result = await client.callTool({ name, arguments: { taskId: id } });
    ok(!result.isError);
    return result.structuredContent;
  };
  const capture = { runId, evidenceSha256 };
  const learning = learningCaseCaptureResultSchema.parse(await post(taskPath + '/learning-case', capture, 201));
  equal(learning.replayed, false);
  const facts = learning.item.document.facts;
  if (kind === 'runbook') equal(facts.category, 'recovered_stopped_instance');
  else {
    ok(facts.category === 'reproduced_health_failure');
    equal(facts.originalHealthStatus, 503);
    equal(facts.repairedHealthStatus, 200);
  }
  equal(learning.item.document.evidenceSha256, evidenceSha256);
  const repeated = learningCaseCaptureResultSchema.parse(await post(taskPath + '/learning-case', capture, 200));
  equal(repeated.replayed, true);
  deepStrictEqual(repeated.item, learning.item);

  const project = '/v1/projects/' + projectId;
  const extraction = admissionDtoSchema.parse(await post(project + '/learning-cases/' + learning.item.id + '/extractions', {
    caseSha256: learning.item.sha256, idempotencyKey: randomUUID(), locale: 'en',
  }, 202));
  equal(extraction.task.workflow, 'rule-extraction');
  const candidate = await untilResult(async () => {
    const view = ruleExtractionViewSchema.parse(await reading('get_rule_extraction', extraction.task.id));
    ok(!['failed', 'needs_human', 'cancelled'].includes(view.state));
    return view.result ?? undefined;
  });
  equal(candidate.document.extraction.caseId, learning.item.id);
  equal(candidate.document.extraction.caseSha256, learning.item.sha256);
  equal(candidate.document.provider, 'anthropic');
  const selected = candidate.document.extraction.result;
  ok(selected.outcome === 'candidate' && selected.candidate.kind === kind);
  const candidatePath = project + '/rule-candidates/' + candidate.id;
  const validation = admissionDtoSchema.parse(await post(candidatePath + '/validations', {
    extractionResultSha256: candidate.sha256, idempotencyKey: randomUUID(), locale: 'en',
  }, 202));
  equal(validation.task.workflow, 'rule-validation');
  const verified = await untilResult(async () => {
    const view = candidateValidationViewSchema.parse(await reading('get_candidate_validation', validation.task.id));
    ok(!['failed', 'needs_human', 'cancelled'].includes(view.state));
    return view.result ?? undefined;
  });
  equal(verified.document.status, 'passed');
  equal(verified.document.candidateId, candidate.id);
  const evidence = verified.document.evidence;
  equal(evidence.kind, kind);
  if (evidence.kind === 'runbook') {
    deepStrictEqual(evidence.result.scenarios, {
      eligible: 'ready_for_guarded_dispatch', healthy: 'observe_only', stale: 'stop_target_drift',
      unapproved: 'await_approval', exhausted: 'stop_attempt_limit', revoked: 'stop_approval',
    });
    deepStrictEqual(evidence.result.recovery, {
      verified: 'verified_recovered', replaced: 'stop_target_drift', unknown: 'stop_unknown',
      unhealthy: 'stop_failed_health', anonymous: 'stop_failed_health',
    });
  } else {
    ok(evidence.receipt.cleanupConfirmed);
    deepStrictEqual(evidence.receipt.proof.result.samples.map(sample => [sample.name, sample.status === 'checked' ? sample.matches : null]),
      [['violation', 1], ['corrected', 0], ['lookalike', 0]]);
  }

  const { version } = rulePackageImportResultSchema.parse(await post(candidatePath + '/package-drafts', {
    packageKey: selected.candidate.key, version: '1.0.0', scope: 'workspace',
    validationId: verified.id, validationSha256: verified.sha256, source: { name: 'Reference recovery case', license: 'Apache-2.0' },
    text: Object.fromEntries(Object.entries(selected.candidate.text).map(([locale, entry]) => [locale,
      { title: entry.title, description: entry.appliesTo }])),
  }, 201));
  ok(version.document.kind === kind);
  equal(version.document.validation.id, verified.id);
  equal(version.document.validation.sha256, verified.sha256);
  await page.evaluate(({ packageId, versionId }) => {
    location.hash = '#/rule-packages/' + packageId + '/versions/' + versionId;
  }, version);
  await page.getByRole('checkbox', { name: 'I verified the source and license.', exact: true }).check();
  await page.getByRole('checkbox', { name: 'I checked the scope and guidance.', exact: true }).check();
  await page.getByRole('checkbox', { name: 'I checked the validation receipt and candidate.', exact: true }).check();
  const packagePath = '/v1/rule-packages/' + version.packageId;
  const review = rulePackageImportResultSchema.parse(await portalPost(page,
    packagePath + '/versions/' + version.versionId + '/review', page.getByRole('button', { name: 'Record review', exact: true }), 201));
  ok(review.version.review?.outcome === 'accepted');
  const reviewSha256 = review.version.review.sha256;
  await page.getByRole('button', { name: 'Publish version', exact: true }).click();
  const activation = rulePackageActivationResultSchema.parse(await portalPost(page, packagePath + '/activation',
    page.getByRole('dialog', { name: 'Confirm version change' }).getByRole('button', { name: 'Publish version', exact: true }), 201));
  equal(activation.replayed, false);
  equal(activation.operation.sequence, 1);
  equal(activation.operation.versionId, version.versionId);
  equal(activation.operation.versionSha256, version.sha256);
  equal(activation.operation.reviewSha256, reviewSha256);
  deepStrictEqual(activation.state.current, activation.operation);
  const publication: ReferenceRule = { packageId: version.packageId, packageKey: version.document.packageKey,
    versionId: version.versionId, versionSha256: version.sha256, sequence: 1, reviewSha256, validationSha256: verified.sha256 };
  return { publication, caseId: learning.item.id, caseSha256: learning.item.sha256, candidateSha256: candidate.sha256, evidenceSha256,
    ...(evidence.kind === 'code_rule' ? { validationGuestId: evidence.receipt.domainId } : {}) };
}
