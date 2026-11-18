import { z } from 'zod';
import { apiErrorSchema, translate, type ApiErrorCode, type Locale } from '@itervane/contracts';
import { BrowserSession, SessionLost } from './auth.js';
import { ui, type UiKey } from './messages.js';

export class ApiFailure extends Error {
  constructor(readonly key: UiKey, readonly code?: ApiErrorCode, readonly requestId?: string) { super('portal_request_failed'); }
}
export function errorText(error: unknown, locale: Locale) {
  if (error instanceof ApiFailure) return error.code ? translate(locale, `error.${error.code}`) : ui(locale, error.key);
  return ui(locale, error instanceof SessionLost ? 'sessionExpired' : 'networkError');
}
export class PortalApi {
  constructor(readonly session: BrowserSession) {}
  async request<T>(path: string, schema: z.ZodType<T>, locale: Locale, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    if (!/^\/v1\/[a-z0-9/?=&-]+$/i.test(path)) throw new ApiFailure('invalidResponse');
    const { token, epoch } = await this.session.token();
    try {
      const response = await fetch(path, { method: options.method ?? 'GET', credentials: 'omit', mode: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Accept-Language': locale, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
      if (epoch !== this.session.getSnapshot().epoch) throw new SessionLost();
      if (response.status === 401) { this.session.rejectToken(token); throw new SessionLost(); }
      const body: unknown = await response.json();
      if (epoch !== this.session.getSnapshot().epoch) throw new SessionLost();
      if (!response.ok) {
        const error = apiErrorSchema.safeParse(body);
        throw error.success ? new ApiFailure('networkError', error.data.error.code, error.data.error.requestId) : new ApiFailure('invalidResponse');
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) throw new ApiFailure('invalidResponse');
      return parsed.data;
    } catch (error) {
      if (error instanceof ApiFailure || error instanceof SessionLost || options.signal?.aborted) throw error;
      throw new ApiFailure('networkError');
    }
  }
}
