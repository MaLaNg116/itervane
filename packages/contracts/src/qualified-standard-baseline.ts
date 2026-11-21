import { z } from 'zod';
import { sha256Schema } from './inspection.js';

const checkIds = ['health', 'version', 'synthetic_data', 'page', 'compiled_asset'] as const;
const check = z.strictObject({
  id: z.enum(checkIds), status: z.enum(['passed', 'failed', 'blocked']),
  code: z.enum(['unexpected_status', 'unexpected_content', 'timeout', 'unavailable', 'missing_page_asset']).nullable(),
  statusCode: z.int().min(100).max(599).nullable(),
}).refine(item => {
  if (item.status === 'passed') return item.statusCode === 200 && item.code === null;
  if (item.status === 'blocked') return item.id === 'compiled_asset' && item.statusCode === null && item.code === 'missing_page_asset';
  return item.code !== null && item.code !== 'missing_page_asset';
});

const binding = z.strictObject({
  version: z.literal(1), baselineSha256: sha256Schema, distSha256: sha256Schema,
});
export const qualifiedStandardBaselineProofSchema = z.discriminatedUnion('status', [
  binding.extend({
    status: z.enum(['passed', 'failed']), appExited: z.literal(true), runtimeInputsSha256: sha256Schema,
    checks: z.array(check).length(checkIds.length),
  }).refine(result => result.checks.every((item, index) => item.id === checkIds[index])
    && (result.status === 'passed' ? result.checks.every(item => item.status === 'passed') : result.checks.some(item => item.status === 'failed'))),
  binding.extend({
    status: z.literal('blocked'),
    code: z.enum(['runtime_preparation', 'runtime_start', 'baseline_unavailable', 'runtime_cleanup_unproven']),
  }),
]);
