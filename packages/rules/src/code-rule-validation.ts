import { codeRuleSampleObservationSchema, codeRuleSampleResultSchema, codeRuleValidationBasisSchema, learningCandidateSchema, ruleSampleKinds,
  type CodeRuleSampleObservation, type CodeRuleSampleResult, type CodeRuleValidationBasis, type RuleSampleKind } from '@itervane/contracts';
import { z } from 'zod';
import { digest } from './catalog.js';

export const maxSemgrepReportBytes = 64 * 1024;
const position = z.object({ line: z.int().min(1).max(1_600), col: z.int().min(1).max(1_601) });
const reportSchema = z.object({
  version: z.string().min(1).max(24), errors: z.array(z.unknown()).max(256),
  paths: z.object({ scanned: z.array(z.string().max(256)).max(3), skipped: z.array(z.unknown()).max(256).optional() }),
  results: z.array(z.object({ check_id: z.string().max(164), path: z.string().max(256), start: position, end: position })).max(256),
});

export function prepareCodeRuleValidation(rawCandidate: unknown, reference: { candidateId: string; extractionResultSha256: string }, profile: unknown) {
  const candidate = learningCandidateSchema.parse(rawCandidate);
  if (candidate.kind !== 'code_rule') throw new Error('code_rule_candidate_required');
  const { key, check, samples } = candidate;
  const expression = check.patternNot
    ? { patterns: [{ pattern: check.pattern }, { 'pattern-not': check.patternNot }] }
    : { pattern: check.pattern };
  const config = JSON.stringify({ rules: [{ id: key, languages: [check.language], message: 'Review this match.', severity: 'WARNING', ...expression }] });
  const extension = check.language === 'javascript' ? 'js' : 'ts';
  const files = ruleSampleKinds.map(name => {
    const content = samples[name].replace(/\r\n/g, '\n');
    return { name, file: name + '.' + extension, content, sha256: digest(content) };
  });
  const basis = codeRuleValidationBasisSchema.parse({
    version: 1, ...reference, candidateSha256: digest(JSON.stringify(candidate)), ruleKey: key, configSha256: digest(config), profile,
    samples: files.map(({ content: _content, ...binding }) => binding),
  });
  return { sha256: digest(JSON.stringify(basis)), basis, config, files };
}

type ScannerRun = { exitCode: number | null; timedOut?: boolean; stdout: string; stderr?: string };

function commandFailureCause(output: string) {
  if (/error while loading shared libraries|cannot open shared object file|GLIBC_[0-9.]+.*not found/i.test(output)) return 'dependency';
  if (/ModuleNotFoundError:|ImportError:/i.test(output)) return 'import';
  if (/PermissionError:|Read-only file system|No space left on device|File size limit exceeded/i.test(output)) return 'filesystem';
  if (/Illegal instruction|semgrep-core exit code:\s*-4\b/i.test(output)) return 'illegal_instruction';
  if (/semgrep-core (?:exit code:|exited with)/i.test(output)) return 'core_exit';
  return 'other';
}

export function normalizeCodeRuleSample(basis: CodeRuleValidationBasis, name: RuleSampleKind, run: ScannerRun): CodeRuleSampleObservation {
  const sample = basis.samples.find(item => item.name === name);
  if (!sample) throw new Error('missing_rule_validation_sample');
  const unavailable = (reason: Extract<CodeRuleSampleObservation, { status: 'unavailable' }>['reason']) =>
    ({ ...sample, status: 'unavailable' as const, reason });
  if (run.timedOut) return unavailable('timeout');
  if (run.exitCode === null) return unavailable('engine_unavailable');
  if (run.exitCode !== 0) return { ...unavailable('command_failed'), detail: { exitCode: run.exitCode,
    cause: commandFailureCause((run.stderr ?? '') + '\n' + run.stdout) } };
  if (!run.stdout.isWellFormed() || Buffer.byteLength(run.stdout) > maxSemgrepReportBytes) return unavailable('invalid_report');
  let raw: unknown;
  try { raw = JSON.parse(run.stdout); } catch { return unavailable('invalid_report'); }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return unavailable('invalid_report');
  const observed = parsed.data;
  if (observed.version !== basis.profile.engineVersion) return unavailable('version_mismatch');
  const path = (file: string) => file.startsWith('./') ? file.slice(2) : file;
  if (observed.errors.length || observed.paths.skipped?.length || observed.paths.scanned.length !== 1
      || path(observed.paths.scanned[0]!) !== sample.file) return unavailable('incomplete_coverage');
  const locations = new Set<string>();
  for (const match of observed.results) {
    if (match.check_id !== basis.ruleKey || path(match.path) !== sample.file
        || match.start.line > match.end.line || (match.start.line === match.end.line && match.start.col >= match.end.col)) {
      return unavailable('invalid_match');
    }
    const location = JSON.stringify([match.start.line, match.start.col, match.end.line, match.end.col]);
    if (locations.has(location)) return unavailable('invalid_match');
    locations.add(location);
  }
  return { ...sample, status: 'checked', reportSha256: digest(run.stdout), matches: locations.size };
}

export function summarizeCodeRuleSamples(basis: CodeRuleValidationBasis, rawResults: readonly unknown[]): CodeRuleSampleResult {
  if (rawResults.length !== 3) throw new Error('incomplete_rule_validation_samples');
  const samples = rawResults.map(item => codeRuleSampleObservationSchema.parse(item));
  for (const [index, sample] of samples.entries()) {
    const expected = basis.samples[index];
    if (!expected || sample.name !== expected.name || sample.file !== expected.file || sample.sha256 !== expected.sha256) {
      throw new Error('rule_validation_sample_binding');
    }
  }
  const status = samples.some(item => item.status === 'unavailable') ? 'unavailable'
    : samples.every(item => item.status === 'checked' && item.matches === (item.name === 'violation' ? 1 : 0)) ? 'passed' : 'failed';
  return codeRuleSampleResultSchema.parse({ version: 1, basisSha256: digest(JSON.stringify(basis)), status, samples });
}
