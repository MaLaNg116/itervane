import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createFormalVerification } from '@itervane/agent';
import { formalVerificationEvidenceSchema, formalVerificationInputSchema, sha256Schema } from '@itervane/contracts';
import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { localModel } from '../agent/loopback-model.js';
import { sourceFingerprint } from '../report.js';

const fixture = z.object({
  cleanupConfirmed: z.literal(true),
  receiptSha256: sha256Schema,
  reviewTrial: z.object({
    input: z.strictObject({ sha256: sha256Schema, document: formalVerificationInputSchema }),
    evidence: formalVerificationEvidenceSchema,
  }),
}).refine(trial => trial.receiptSha256 === trial.reviewTrial.evidence.binding.receiptSha256);
const reportSchema = z.object({ sourceFingerprint: sha256Schema, built: fixture, healthRegression: fixture });

async function main([flag, artifactPath, ...extra]: string[]) {
  if (flag !== '--live' || !artifactPath || extra.length) {
    console.error('Usage: pnpm probe:formal-verify --live <runner-worker-build.json>');
    return 2;
  }
  const model = localModel();
  if (!model) {
    console.error('Configure the selected protocol with an explicit loopback base URL, API key and model.');
    return 2;
  }
  const file = await stat(artifactPath);
  if (!file.isFile() || file.size > 8 * 1024 * 1024) throw new Error('invalid native evidence file');
  const artifact = reportSchema.parse(JSON.parse(await readFile(artifactPath, 'utf8')));
  const trials = [
    { id: 'healthy', trial: artifact.built.reviewTrial, locale: 'en', outcome: 'observed', imageRead: true },
    { id: 'health-regression', trial: artifact.healthRegression.reviewTrial, locale: 'zh-CN', outcome: 'checks_failed', imageRead: false },
  ] as const;
  const runs = [];
  for (const { id, trial, locale, outcome, imageRead } of trials) {
    if (trial.input.document.locale !== locale || trial.evidence.baseline.status !== (imageRead ? 'passed' : 'failed')) {
      throw new Error('unexpected native trial');
    }
    const result = await createFormalVerification({ ...trial, model: model.adapter, providerSha256: model.providerSha256,
      checkpointer: new MemorySaver(), authorize: async () => true }).run();
    const observations = result.evidence.filter(item => item.data.kind === 'verification_section');
    const sections = observations.flatMap(item => item.data.kind === 'verification_section' ? [item.data.section] : []);
    const review = result.formalVerification;
    const cited = review?.evidenceIds.length === observations.length && observations.every(item => review.evidenceIds.includes(item.id));
    const localized = locale === 'zh-CN' ? /[\u3400-\u9fff]/u.test(review?.summary ?? '') : /[A-Za-z]/u.test(review?.summary ?? '');
    const passed = result.status === 'completed' && result.releaseEligible === false && review?.outcome === outcome
      && review.receiptSha256 === trial.evidence.binding.receiptSha256 && sections.includes('image') === imageRead
      && Boolean(cited) && localized;
    runs.push({ id, locale, status: result.status, reason: result.reason, outcome: review?.outcome, sections,
      receiptSha256: trial.evidence.binding.receiptSha256, usage: result.usage, localized, passed });
  }
  const distinctPaths = new Set(runs.map(run => JSON.stringify(run.sections))).size === trials.length;
  const passed = distinctPaths && runs.every(run => run.passed);
  const value = { protocol: model.adapter.protocol, evidenceOrigin: 'native_runner_artifact', runtimeQualified: false,
    checkedAt: new Date().toISOString(), sourceFingerprint: await sourceFingerprint(), runnerSourceFingerprint: artifact.sourceFingerprint,
    distinctPaths, passed, runs };
  await mkdir('.reports/p2-d3-d', { recursive: true });
  await writeFile('.reports/p2-d3-d/live-loopback.json', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(value, null, 2));
  return passed ? 0 : 1;
}

try { process.exitCode = await main(process.argv.slice(2)); }
catch { console.error('The formal verification probe could not finish.'); process.exitCode = 1; }
