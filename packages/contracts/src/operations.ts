import { z } from 'zod';
import { sha256Schema } from './inspection.js';
import { idSchema, serviceOriginSchema } from './primitives.js';

export const whiskersEndpointSchema = z.strictObject({
  origin: serviceOriginSchema('Whiskers'),
  serverId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
});

export const operationsTargetInputSchema = z.strictObject({
  environmentId: idSchema,
  releaseTargetRevision: z.int().min(1).max(2_147_483_647),
  releaseTargetSha256: sha256Schema,
  whiskers: whiskersEndpointSchema,
});

export type OperationsTargetInput = z.infer<typeof operationsTargetInputSchema>;
