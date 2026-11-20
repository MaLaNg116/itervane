import { AuthenticationError } from '../auth/identity.js';
import { DomainError } from './errors.js';
import { apiErrorSchema, translate, type ApiErrorCode, type Locale, type MessageKey } from '@itervane/contracts';

export const statusFor: Record<ApiErrorCode, number> = {
  invalid_input: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409,
  idempotency_conflict: 409, version_conflict: 409, unsupported_state: 409, unavailable: 503, internal_error: 500, resume_limit: 409,
};
export function errorCode(error: unknown): ApiErrorCode {
  if (error instanceof AuthenticationError || error instanceof DomainError) return error.code;
  let value = error;
  for (let depth = 0; depth < 4 && value && typeof value === 'object'; depth++) {
    const candidate = value as { code?: string; cause?: unknown; statusCode?: number };
    if (candidate.code === '23505') return 'conflict';
    if (candidate.code === '23503') return 'not_found';
    if (candidate.statusCode && candidate.statusCode >= 400 && candidate.statusCode < 500) return 'invalid_input';
    value = candidate.cause;
  }
  return 'internal_error';
}
export function localizedError(code: ApiErrorCode, requestId: string, locale: Locale) {
  const messageKey: MessageKey = `error.${code}`;
  return apiErrorSchema.parse({ error: { code, requestId, messageKey, message: translate(locale, messageKey), locale } });
}
