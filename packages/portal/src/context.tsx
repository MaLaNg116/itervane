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
export function useRemote<T>(path: string, schema: z.ZodType<T>, options: { poll?: boolean; localized?: boolean } = {}) {
  const { api, locale, epoch } = usePortal();
  return useQuery({ queryKey: [epoch, path, ...(options.localized ? [locale] : [])],
    queryFn: ({ signal }) => api.request(path, schema, locale, { signal }),
    retry: false, staleTime: 0, refetchInterval: options.poll ? 3_000 : false, refetchIntervalInBackground: false });
}
