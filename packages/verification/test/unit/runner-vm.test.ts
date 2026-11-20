import { describe, expect, it } from 'vitest';
import { parseRunnerProbeOutput } from '../../src/runner-vm.js';

describe('D2-A sanitized native VM probe result', () => {
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
});
