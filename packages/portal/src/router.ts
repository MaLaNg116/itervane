import { idSchema } from '@itervane/contracts';

export type Route = { page: 'projects' } | { page: 'project'; id: string } | { page: 'task'; id: string } | { page: 'preaudit'; id: string } | { page: 'preaudit-report'; id: string } | { page: 'not-found' };
export function readRoute(hash: string): Route {
  if (hash === '' || hash === '#/projects') return { page: 'projects' };
  const preaudit = /^#\/(?:projects\/([^/]+)\/preaudit|preaudits\/([^/]+))$/.exec(hash);
  if (preaudit) { const id = preaudit[1] ?? preaudit[2]; return idSchema.safeParse(id).success ? { page: preaudit[1] ? 'preaudit' : 'preaudit-report', id: id! } : { page: 'not-found' }; }
  const match = /^#\/(projects|tasks)\/([^/]+)$/.exec(hash);
  if (!match || !idSchema.safeParse(match[2]).success) return { page: 'not-found' };
  return { page: match[1] === 'projects' ? 'project' : 'task', id: match[2]! };
}
export function safeReturnHash(value: unknown): string {
  return typeof value === 'string' && readRoute(value).page !== 'not-found' ? value || '#/projects' : '#/projects';
}
export const navigate = (hash: string) => { location.hash = safeReturnHash(hash); };
