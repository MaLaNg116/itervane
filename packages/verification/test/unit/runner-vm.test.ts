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
  });
});
