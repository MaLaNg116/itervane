import { describe, expect, it } from 'vitest';
import { parseRunnerProbeOutput } from '../../src/runner-vm.js';

describe('sanitized native VM probe result', () => {
  const runId = 'cb80794f-08aa-4a0f-8ab2-58c16dcad79e';
  const imageSha256 = 'a'.repeat(64);

  it('requires a native run identity and the configured image digest for success', () => {
    const valid = { code: 'passed', runId, imageSha256 };
    expect(parseRunnerProbeOutput(JSON.stringify(valid), imageSha256)).toEqual(valid);
    for (const invalid of [
      { ...valid, runId: null },
      { ...valid, imageSha256: null },
      { ...valid, imageSha256: 'b'.repeat(64) },
      { ...valid, runId: 'invalid' },
      { ...valid, raw: 'unexpected stderr' },
      { ...valid, profileIssue: 'device-interface' },
    ]) {
      expect(parseRunnerProbeOutput(JSON.stringify(invalid), imageSha256)).toEqual({
        code: 'driver_lost', runId: null, imageSha256: null,
      });
    }
  });

  it('preserves a blocked KVM result and the ID for uncertain cleanup', () => {
    const blocked = { code: 'kvm_unavailable', runId: null, imageSha256: null };
    const pending = { code: 'cleanup_unproven', runId, imageSha256 };
    for (const result of [blocked, pending]) {
      expect(parseRunnerProbeOutput(JSON.stringify(result), imageSha256)).toEqual(result);
    }
    expect(parseRunnerProbeOutput('invalid stdout', imageSha256).code).toBe('driver_lost');
  });

  it('requires positive host identity and exit evidence for a dedicated session success', () => {
    const verified = { code: 'passed', runId, imageSha256, cleanupConfirmed: true, sessionVerified: true };
    expect(parseRunnerProbeOutput(JSON.stringify(verified), imageSha256, 'session')).toEqual(verified);
    expect(parseRunnerProbeOutput(JSON.stringify(verified), imageSha256).code).toBe('driver_lost');
    for (const invalid of [{ ...verified, cleanupConfirmed: false }, { ...verified, sessionVerified: false }]) {
      expect(parseRunnerProbeOutput(JSON.stringify(invalid), imageSha256, 'session').code).toBe('driver_lost');
    }
  });

  it('retains a bounded profile diagnostic without accepting a path', () => {
    const rejected = { code: 'profile_rejected', runId, imageSha256, profileIssue: 'disk-child-seclabel' };
    expect(parseRunnerProbeOutput(JSON.stringify(rejected), imageSha256)).toEqual(rejected);
    expect(parseRunnerProbeOutput(JSON.stringify({ ...rejected, profileIssue: '/private/source' }), imageSha256).code).toBe('driver_lost');
  });

  it('requires a bound full receipt and confirmed cleanup for a terminal job result', () => {
    const job = { byteCount: 1048576, startedBytes: 65536, inputSha256: 'b'.repeat(64), receivedSha256: 'b'.repeat(64) };
    const valid = { code: 'job_passed', runId, imageSha256, cleanupConfirmed: true, job };
    const mismatch = { ...valid, code: 'job_input_rejected', job: { ...job, receivedSha256: 'c'.repeat(64) } };
    for (const result of [valid, mismatch]) {
      expect(parseRunnerProbeOutput(JSON.stringify(result), imageSha256)).toEqual(result);
    }
    for (const invalid of [
      { ...valid, cleanupConfirmed: false },
      { ...valid, runId: null },
      { ...valid, job: { ...job, byteCount: 32 * 1024 * 1024 + 1 } },
      { ...valid, job: { ...job, startedBytes: 1 } },
      { ...valid, job: { ...job, receivedSha256: null } },
      { ...valid, code: 'job_input_rejected' },
      { ...mismatch, code: 'job_passed' },
    ]) {
      expect(parseRunnerProbeOutput(JSON.stringify(invalid), imageSha256).code).toBe('driver_lost');
    }
    const interrupted = { ...valid, code: 'cancelled', job: { ...job, receivedSha256: null } };
    expect(parseRunnerProbeOutput(JSON.stringify(interrupted), imageSha256)).toEqual(interrupted);
    const unresolved = { ...interrupted, code: 'cleanup_unproven', cleanupConfirmed: false };
    expect(parseRunnerProbeOutput(JSON.stringify(unresolved), imageSha256)).toEqual(unresolved);
    const timeout = { ...interrupted, code: 'job_deadline_exceeded', jobIssue: 'result' };
    expect(parseRunnerProbeOutput(JSON.stringify(timeout), imageSha256)).toEqual(timeout);
    expect(parseRunnerProbeOutput(JSON.stringify({ ...timeout, jobIssue: '/private/port' }), imageSha256).code).toBe('driver_lost');
    const session = { ...valid, sessionVerified: true };
    expect(parseRunnerProbeOutput(JSON.stringify(session), imageSha256, 'session').code).toBe('driver_lost');
    const withWorkload = { ...session, job: { ...session.job, workloadVerified: true } };
    expect(parseRunnerProbeOutput(JSON.stringify(withWorkload), imageSha256, 'session')).toEqual(withWorkload);
  });

  it('requires the source scenario, dedicated session cleanup and a bounded object receipt', () => {
    const source = {
      originSha256: 'b'.repeat(64), commit: 'c'.repeat(40), tree: 'd'.repeat(40),
      commitSha256: 'e'.repeat(64), files: 290, requests: 3, transferredBytes: 4000,
    };
    const valid = { code: 'source_passed', runId, imageSha256, cleanupConfirmed: true, sessionVerified: true, source };
    const rejected = { code: 'source_rejected', runId, imageSha256, cleanupConfirmed: true,
      sessionVerified: true, jobIssue: 'address-rejected' };
    expect(parseRunnerProbeOutput(JSON.stringify(valid), imageSha256, 'session', 'source')).toEqual(valid);
    expect(parseRunnerProbeOutput(JSON.stringify(rejected), imageSha256, 'session', 'source')).toEqual(rejected);
    expect(parseRunnerProbeOutput(JSON.stringify(valid), imageSha256, 'session', 'job').code).toBe('driver_lost');
    expect(parseRunnerProbeOutput(JSON.stringify(valid), imageSha256, 'system', 'source').code).toBe('driver_lost');
    for (const invalid of [
      { ...valid, cleanupConfirmed: false },
      { ...valid, sessionVerified: false },
      { ...valid, source: null },
      { ...valid, source: { ...source, files: 5001 } },
      { ...valid, source: { ...source, raw: 'source text' } },
      { ...valid, code: 'cleanup_unproven', cleanupConfirmed: false },
      { ...valid, code: 'passed', source: null },
      { ...rejected, jobIssue: '/private/source' },
    ]) {
      expect(parseRunnerProbeOutput(JSON.stringify(invalid), imageSha256, 'session', 'source').code).toBe('driver_lost');
    }
  });

  it('accepts the scan receipt only with the same source, run and actual isolation evidence', () => {
    const source = { originSha256: 'a'.repeat(64), commit: 'b'.repeat(40), tree: 'c'.repeat(40),
      commitSha256: 'd'.repeat(64), files: 305, requests: 3, transferredBytes: 4200 };
    const proof = { policySha256: 'e'.repeat(64), findings: 2, resultSha256: 'f'.repeat(64) };
    const repair = { path: 'fixtures/runner/inspection-input/README.md', baseSnapshotSha256: 'a'.repeat(64),
      beforeSha256: 'b'.repeat(64), afterSha256: 'c'.repeat(64), patchSha256: 'd'.repeat(64),
      candidateManifestSha256: 'e'.repeat(64), replayed: true, originalRetained: true,
      protectedRejected: true, staleRejected: true, rangeRejected: true };
    const inspection = { runId, commit: source.commit, tree: source.tree, files: 305, totalBytes: 1200000,
      manifestSha256: 'a'.repeat(64), inputsSha256: 'b'.repeat(64), offline: true, readOnly: true, controlsChecked: true,
      missingDatabaseRejected: true, repair, gitleaks: { ...proof, version: '8.30.1' },
      trivy: { ...proof, version: '0.76.2', databaseSha256: 'c'.repeat(64), databaseUpdatedAt: '2026-11-19T10:00:00Z' } };
    const valid = { code: 'inspection_passed', runId, imageSha256, cleanupConfirmed: true, sessionVerified: true, source, inspection };
    expect(parseRunnerProbeOutput(JSON.stringify(valid), imageSha256, 'session', 'inspect')).toEqual(valid);
    expect(parseRunnerProbeOutput(JSON.stringify(valid), imageSha256, 'session', 'source').code).toBe('driver_lost');
    for (const invalid of [
      { ...valid, inspection: { ...inspection, tree: 'd'.repeat(40) } },
      { ...valid, inspection: { ...inspection, offline: false } },
      { ...valid, inspection: { ...inspection, readOnly: false } },
      { ...valid, inspection: { ...inspection, repair: { ...repair, rangeRejected: false } } },
      { ...valid, inspection: { ...inspection, repair: { ...repair, baseSnapshotSha256: 'f'.repeat(64) } } },
      { ...valid, inspection: { ...inspection, repair: { ...repair, afterSha256: repair.beforeSha256 } } },
      { ...valid, inspection: { ...inspection, trivy: { ...inspection.trivy, raw: 'secret text' } } },
      { ...valid, cleanupConfirmed: false },
    ]) {
      expect(parseRunnerProbeOutput(JSON.stringify(invalid), imageSha256, 'session', 'inspect').code).toBe('driver_lost');
    }
  });
});
