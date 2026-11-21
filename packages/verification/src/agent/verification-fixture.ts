import { sha256, type AgentEvidence } from '@itervane/agent';
import { formalVerificationEvidenceSchema, formalVerificationInputSchema, type Locale } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';
import { auditFixture } from './formal-fixture.js';

export function verificationFixture(locale: Locale, regression = false) {
  const audited = auditFixture(locale, 0, false);
  const { taskId, projectId, runId, generation, source, dataClass, inspection, catalog } = audited.input.document;
  const digest = (label: string) => 'sha256:' + sha256(label);
  const profile = {
    id: 'standard-web', policySha256: sha256('verification policy'), baselineSha256: sha256('protected baseline'),
    scannerInputsSha256: sha256('scanner inputs'), runnerImageSha256: sha256('runner image'),
    buildProfileSha256: sha256('build profile'), runStandardBaseline: true, ociInputsSha256: sha256('OCI inputs'), retainStandardImage: true,
  };
  const document = formalVerificationInputSchema.parse({
    version: 1, taskId, projectId, runId, generation, source, dataClass, locale, inspection,
    audit: { inputSha256: audited.input.sha256, resultSha256: sha256('audit result'), checkpointId: runId },
    catalogSha256: catalog.sha256, profile, subject: { kind: 'original', manifestSha256: inspection.snapshotSha256 },
  });
  const input = { document, sha256: sha256(JSON.stringify(document)) };
  const evidence = formalVerificationEvidenceSchema.parse({
    version: 1, binding: { taskId, projectId, runId, generation, source, verificationInputSha256: input.sha256,
      receiptSha256: sha256('checked runner receipt'), subjectManifestSha256: inspection.snapshotSha256 },
    source: { status: 'compared', resolved: 0, introduced: 0, remaining: 0 },
    build: { status: 'built', distSha256: sha256('distribution bytes') },
    baseline: { status: regression ? 'failed' : 'passed', baselineSha256: profile.baselineSha256,
      runtimeInputsSha256: sha256('immutable runtime inputs'),
      failures: regression ? [{ id: 'health', code: 'unexpected_status', statusCode: 503 }] : [],
    },
    image: regression ? { status: 'not_reached' } : {
      status: 'scanned', manifestDigest: digest('manifest'), configDigest: digest('image config'),
      databaseSha256: sha256('vulnerability database'), scanReportSha256: sha256('scan report'),
      scanPolicySha256: sha256('scan policy'), osPackages: 92, npmPackages: 69,
      findings: { critical: 0, high: 0, medium: 30, low: 5, unknown: 0 },
      archive: { format: 'oci-layout-tar', sha256: sha256('OCI archive'), bytes: 79_042_560 },
    },
  });
  return { input, evidence, authorize: audited.authorize, checkpointer: audited.checkpointer, providerSha256: audited.providerSha256 };
}

export const verificationDecision = (name: string, input: unknown) =>
  ({ text: '', calls: [{ id: 'decision', name, input }], tokenUsage: 20 });

export function scriptedVerification(locale: Locale): ModelAdapter {
  return { protocol: 'anthropic', async complete({ conversation }) {
    const message = conversation[0];
    if (message?.kind !== 'user') throw new Error('Missing verification context');
    const { observations } = JSON.parse(message.text) as { observations: AgentEvidence[] };
    const sections = observations.flatMap(({ data, id }) => data.kind === 'verification_section' ? [{ ...data, id }] : []);
    const baseline = sections.find(item => item.section === 'baseline');
    if (!baseline) return verificationDecision('read_verification', { section: 'baseline' });
    if (baseline.result.status === 'passed' && !sections.some(item => item.section === 'image')) {
      return verificationDecision('read_verification', { section: 'image' });
    }
    for (const section of ['source', 'build']) {
      if (!sections.some(item => item.section === section)) return verificationDecision('read_verification', { section });
    }
    const failed = baseline.result.status === 'failed';
    return verificationDecision('finish_role', {
      summary: locale === 'zh-CN' ? '当前候选的检查事实已汇总。' : 'The observations describe the current candidate.',
      evidenceIds: sections.map(item => item.id),
      followUps: failed ? [{ evidenceId: baseline.id,
        detail: locale === 'zh-CN' ? '核对健康端点返回 503 的原因。' : 'Investigate the health endpoint response of 503.' }] : [],
    });
  } };
}
