import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { checkSchema, summarizeChecks, type Check } from '@itervane/contracts';
import { report, sourceFingerprint } from './report.js';

const storedReportSchema = z.object({
  probe: z.string(), checkedAt: z.iso.datetime(), runId: z.uuid(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['passed', 'failed', 'blocked']), checks: z.array(checkSchema),
}).strict().refine(value => summarizeChecks(value.checks) === value.status, 'Inconsistent report status');

export function checkStoredReport(name: string, candidate: unknown, fingerprint: string, now = Date.now()): Check {
  const parsed = storedReportSchema.safeParse(candidate);
  if (parsed.success) {
    const value = parsed.data;
    const age = now - Date.parse(value.checkedAt);
    if (value.probe === name && value.sourceFingerprint === fingerprint && age >= -60_000 && age <= 24 * 60 * 60 * 1_000) {
      return { id: name, status: value.status, detail: 'Fresh local evidence for current sources. This is not production authorization.' };
    }
  }
  return { id: name, status: 'blocked', detail: 'No valid, fresh verification report for current sources.' };
}

export async function probeReadiness() {
  const fingerprint = await sourceFingerprint();
  const required = ['engineering', 'database', 'model', 'mcp', 'cloud', 'native-operations', 'evaluation'];
  const checks = await Promise.all(required.map(async name => {
    let value: unknown;
    try { value = JSON.parse(await readFile(`.reports/p0/${name}.json`, 'utf8')); }
    catch { value = undefined; }
    return checkStoredReport(name, value, fingerprint);
  }));
  return report('readiness', checks);
}
