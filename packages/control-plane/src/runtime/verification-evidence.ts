import { formalVerificationEvidenceSchema, type FormalVerificationEvidence, type QualifiedVerificationReceipt } from '@itervane/contracts';
import { sha256, type compareVerificationScans } from '@itervane/runner';

function pending(requested: boolean) {
  return { status: requested ? 'not_reached' : 'not_requested' } as const;
}

type Build = QualifiedVerificationReceipt['snapshot']['build'];
type Baseline = Extract<NonNullable<Build>, { status: 'built' }>['baseline'];
type Image = Extract<NonNullable<Baseline>, { status: 'passed' | 'failed' }>['image'];

function summarizeBuild(build: Build, requested: boolean): FormalVerificationEvidence['build'] {
  if (!build) return pending(requested);
  if (build.status === 'built') return { status: build.status, distSha256: build.dist.sha256 };
  return { status: build.status, code: build.code };
}

function summarizeBaseline(baseline: Baseline, requested: boolean) {
  if (!baseline) return pending(requested);
  if (baseline.status === 'blocked') return { status: baseline.status, code: baseline.code };
  return { status: baseline.status, baselineSha256: baseline.baselineSha256, runtimeInputsSha256: baseline.runtimeInputsSha256,
    failures: baseline.checks.filter(check => check.status !== 'passed').map(({ id, code, statusCode }) => ({ id, code, statusCode })) };
}

function summarizeImage(image: Image, requested: boolean): FormalVerificationEvidence['image'] {
  if (!image) return pending(requested);
  if (image.status === 'blocked') return { status: image.status, code: image.code };
  const severity = { UNKNOWN: 'unknown', LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' } as const;
  const findings = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const finding of image.scan.findings) findings[severity[finding.severity]] += 1;
  return {
    status: image.status, manifestDigest: image.manifestDigest, configDigest: image.configDigest,
    databaseSha256: image.scan.database.sha256, scanReportSha256: image.scan.reportSha256, scanPolicySha256: image.scan.policySha256,
    osPackages: image.scan.osPackages, npmPackages: image.scan.npmPackages, findings, archive: image.archive ?? null,
  };
}

/** Project verified Runner results without exposing source paths, scan text or application responses. */
export function projectVerificationEvidence(receipt: QualifiedVerificationReceipt, comparison: ReturnType<typeof compareVerificationScans>) {
  const { scope, snapshot } = receipt;
  const build = snapshot.build;
  const baseline = build?.status === 'built' ? build.baseline : undefined;
  const image = baseline?.status === 'passed' ? baseline.image : undefined;

  return formalVerificationEvidenceSchema.parse({
    version: 1,
    binding: {
      taskId: scope.taskId, runId: scope.runId, projectId: scope.projectId, generation: scope.generation,
      source: { repositoryId: scope.repositoryId, commit: scope.commit },
      verificationInputSha256: scope.verificationInputSha256, receiptSha256: sha256(JSON.stringify(receipt)),
      subjectManifestSha256: scope.targetManifestSha256,
    },
    source: comparison.status === 'compared' ? { status: comparison.status, ...comparison.totals } : comparison,
    build: summarizeBuild(build, Boolean(scope.buildProfileSha256)),
    baseline: summarizeBaseline(baseline, Boolean(scope.runStandardBaseline)),
    image: summarizeImage(image, Boolean(scope.ociInputsSha256)),
  });
}
