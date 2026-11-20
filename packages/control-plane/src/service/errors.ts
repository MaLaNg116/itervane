import type { ApiErrorCode } from '@itervane/contracts';
import type { z } from 'zod';

export class DomainError extends Error {
  constructor(readonly code: ApiErrorCode) { super(code); this.name = 'DomainError'; }
}

export function parseInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DomainError('invalid_input');
  return parsed.data;
}
