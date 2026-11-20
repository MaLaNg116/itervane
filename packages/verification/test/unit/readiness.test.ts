import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { checkStoredReport } from '../../src/readiness.js';

const fingerprint = 'a'.repeat(64);
const now = Date.parse('2026-11-16T00:00:00.000Z');
const evidence = () => ({
  probe: 'model', runId: randomUUID(), checkedAt: new Date(now).toISOString(), sourceFingerprint: fingerprint,
  status: 'passed', checks: [{ id: 'live-inference', status: 'passed', detail: 'Observation proof verified.' }],
});

it('does not infer readiness from a missing report or an empty success claim', () => {
  expect(checkStoredReport('model', undefined, fingerprint, now).status).toBe('blocked');
  expect(checkStoredReport('model', { ...evidence(), checks: [] }, fingerprint, now).status).toBe('blocked');
});

it('rejects stale evidence, mismatched sources, wrong probe and inconsistent summaries', () => {
  const invalid = [
    { ...evidence(), checkedAt: new Date(now - 25 * 60 * 60 * 1_000).toISOString() },
    { ...evidence(), checkedAt: new Date(now + 120_000).toISOString() },
    { ...evidence(), sourceFingerprint: 'b'.repeat(64) },
    { ...evidence(), probe: 'mcp' },
    { ...evidence(), checks: [{ id: 'actual-failure', status: 'failed', detail: 'Failure.' }] },
  ];
  for (const value of invalid) expect(checkStoredReport('model', value, fingerprint, now).status).toBe('blocked');
});

it('preserves actual failures and blockers while accepting current passing evidence', () => {
  expect(checkStoredReport('model', evidence(), fingerprint, now).status).toBe('passed');
  for (const status of ['failed', 'blocked']) {
    const value = { ...evidence(), status, checks: [{ id: 'inference', status, detail: 'Verified outcome.' }] };
    expect(checkStoredReport('model', value, fingerprint, now).status).toBe(status);
  }
});
