import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { qualifiedStandardImageProofSchema } from './qualified-standard-image.js';

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

export const healthFollowupObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('passed'), code: z.null(), statusCode: z.literal(200) }),
  z.strictObject({ status: z.literal('unhealthy'), code: z.literal('application_unhealthy'), statusCode: z.literal(503) }),
  z.strictObject({ status: z.literal('unavailable'),
    code: z.enum(['timeout', 'unavailable', 'unexpected_status', 'unexpected_content']),
    statusCode: z.int().min(100).max(599).nullable(),
  }),
]);

const binding = z.strictObject({
  version: z.literal(1), baselineSha256: sha256Schema, distSha256: sha256Schema,
});
export const qualifiedStandardBaselineProofSchema = z.discriminatedUnion('status', [
  binding.extend({
    status: z.enum(['passed', 'failed']), appExited: z.literal(true), runtimeInputsSha256: sha256Schema,
    checks: z.array(check).length(checkIds.length),
    healthFollowup: healthFollowupObservationSchema.optional(),
    image: qualifiedStandardImageProofSchema.optional(),
  }).refine(result => result.checks.every((item, index) => item.id === checkIds[index])
    && (!result.image || (result.status === 'passed' && result.runtimeInputsSha256 === result.image.runtimeInputsSha256
      && (!result.healthFollowup || result.healthFollowup.status === 'passed')))
    && (result.status === 'passed' ? result.checks.every(item => item.status === 'passed') : result.checks.some(item => item.status === 'failed'))),
  binding.extend({
    status: z.literal('blocked'),
    code: z.enum(['runtime_preparation', 'runtime_start', 'baseline_unavailable', 'runtime_cleanup_unproven']),
  }),
]);
