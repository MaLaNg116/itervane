import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { catalogSnapshotSchema } from './preaudit.js';
import { idSchema, sourceRefSchema } from './primitives.js';

export const formalAuditInputSchema = z.strictObject({
  version: z.literal(1), taskId: idSchema, runId: idSchema, projectId: idSchema, generation: z.int().positive(),
  source: sourceRefSchema, dataClass: z.enum(['public', 'synthetic']), locale: localeSchema, purposeSha256: sha256Schema,
  inspection: z.strictObject({ requestId: idSchema, receiptSha256: sha256Schema, snapshotSha256: sha256Schema, planSha256: sha256Schema }),
  catalog: catalogSnapshotSchema,
});
export type FormalAuditInput = z.infer<typeof formalAuditInputSchema>;
