import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type { Locale, MeDto } from '@itervane/contracts';
import type { PortalApi } from './api.js';
import type { BrowserSession } from './auth.js';
import { ui, type UiKey } from './messages.js';

export type PortalContextValue = { api: PortalApi; session: BrowserSession; locale: Locale; epoch: number; me: MeDto };
export const PortalContext = createContext<PortalContextValue | null>(null);
export function usePortal() { const context = useContext(PortalContext); if (!context) throw new Error('Portal context unavailable'); return context; }
export function useText() { const { locale } = usePortal(); return (key: UiKey) => ui(locale, key); }
export function useRemote<T>(path: string, schema: z.ZodType<T>, options: {
  poll?: boolean; localized?: boolean; keepOnLocaleChange?: boolean; revision?: number;
} = {}) {
  const { api, locale, epoch } = usePortal();
  return useQuery<T>({ queryKey: [epoch, path, ...(options.localized ? [locale] : []), ...(options.revision === undefined ? [] : [options.revision])],
    queryFn: ({ signal }) => api.request(path, schema, locale, { signal }),
    // Keep form state mounted only while translating the same resource within the same session.
    placeholderData: (previous, query) => options.keepOnLocaleChange && query?.queryKey[0] === epoch && query.queryKey[1] === path ? previous : undefined,
    retry: false, staleTime: 0, refetchInterval: options.poll ? 3_000 : false, refetchIntervalInBackground: false });
}
