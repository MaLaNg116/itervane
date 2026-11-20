import { z } from 'zod';
import { auditFindingsPerScan, formalAuditInputSchema } from './formal-audit.js';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';

export const formalRepairInputSchema = formalAuditInputSchema.pick({
  version: true, taskId: true, projectId: true, runId: true, generation: true,
  source: true, locale: true, dataClass: true, inspection: true,
}).extend({
  audit: z.strictObject({ inputSha256: sha256Schema, resultSha256: sha256Schema, checkpointId: idSchema }),
  catalogSha256: sha256Schema,
  findingIds: z.array(sha256Schema).max(2 * auditFindingsPerScan).refine(ids => new Set(ids).size === ids.length),
});
export type FormalRepairInput = z.infer<typeof formalRepairInputSchema>;
