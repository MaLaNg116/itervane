import { idSchema } from '@itervane/contracts';

export type Route = { page: 'projects' } | { page: 'project'; id: string } | { page: 'task'; id: string } | { page: 'not-found' };
export function readRoute(hash: string): Route {
  if (hash === '' || hash === '#/projects') return { page: 'projects' };
  const match = /^#\/(projects|tasks)\/([^/]+)$/.exec(hash);
  if (!match || !idSchema.safeParse(match[2]).success) return { page: 'not-found' };
  return { page: match[1] === 'projects' ? 'project' : 'task', id: match[2]! };
}
export function safeReturnHash(value: unknown): string {
  return typeof value === 'string' && readRoute(value).page !== 'not-found' ? value || '#/projects' : '#/projects';
}
export const navigate = (hash: string) => { location.hash = safeReturnHash(hash); };
