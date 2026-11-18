import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  admissionDtoSchema, apiErrorSchema, applicationDtoSchema, capabilitiesSchema, environmentDtoSchema,
  idSchema, listQuerySchema, meDtoSchema, projectDtoSchema, repositoryDtoSchema, taskDtoSchema, taskEventDtoSchema,
  type ApiErrorCode,
} from '@itervane/contracts';
import { AuthenticationError, createIdentityVerifier, type IdentityConfig, type VerifiedIdentity } from './auth/identity.js';
import type { Database } from './persistence/database.js';
import { DomainError, parseInput } from './service/errors.js';
import { ResourceService } from './service/resources.js';
import { TaskService } from './service/tasks.js';

declare module 'fastify' {
  interface FastifyRequest { verifiedIdentity: VerifiedIdentity | null }
  interface FastifyContextConfig { public?: boolean }
}

const statusFor: Record<ApiErrorCode, number> = {
  invalid_input: 400, unauthenticated: 401, forbidden: 403, not_found: 404, conflict: 409,
  idempotency_conflict: 409, version_conflict: 409, unsupported_state: 409, unavailable: 503, internal_error: 500,
};
function errorCode(error: unknown): ApiErrorCode {
  if (error instanceof AuthenticationError || error instanceof DomainError) return error.code;
  // 只读取有限层级的错误分类，不返回 SQL、请求内容或驱动异常信息。
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
const projectParam = z.object({ projectId: idSchema }).strict();
const taskParam = z.object({ taskId: idSchema }).strict();
const identity = (request: FastifyRequest) => {
  if (!request.verifiedIdentity) throw new AuthenticationError();
  return request.verifiedIdentity;
};
const limit = (request: FastifyRequest) => parseInput(listQuerySchema, request.query).limit;

export function createApi(database: Database, config: IdentityConfig, options: { logger?: boolean } = {}) {
  const verify = createIdentityVerifier(config);
  const resources = new ResourceService(database); const tasks = new TaskService(database);
  const app = Fastify({
    logger: options.logger === false ? false : { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }), requestIdHeader: false, genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024, requestTimeout: 15_000, connectionTimeout: 10_000,
    trustProxy: false, onProtoPoisoning: 'error', onConstructorPoisoning: 'error',
  });
  app.decorateRequest('verifiedIdentity', null);
  app.addHook('onRequest', async request => {
    if (request.routeOptions.config.public) return;
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization)?.[1];
    if (!token) throw new AuthenticationError();
    request.verifiedIdentity = await verify(token);
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  });
  app.addHook('onResponse', async (request, reply) => {
    app.log.info({ requestId: request.id, method: request.method, route: request.routeOptions.url, status: reply.statusCode }, 'request-completed');
  });
  app.setErrorHandler((error, request, reply) => {
    const code = errorCode(error);
    app.log[statusFor[code] >= 500 ? 'error' : 'warn']({ requestId: request.id, code }, 'request-failed');
    if (code === 'unauthenticated') reply.header('WWW-Authenticate', 'Bearer');
    void reply.code(statusFor[code]).send(apiErrorSchema.parse({ error: { code, requestId: request.id } }));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(apiErrorSchema.parse({ error: { code: 'not_found', requestId: request.id } })));

  app.get('/health/live', { config: { public: true } }, async () => ({ status: 'alive' }));
  app.get('/v1/me', async request => meDtoSchema.parse(await resources.me(identity(request))));
  app.get('/v1/capabilities', async request => {
    await resources.me(identity(request));
    return capabilitiesSchema.parse({ stage: 'p1-a', taskAdmission: true, taskExecution: false, externalMcp: false, sandbox: false, deployment: false, operations: false });
  });
  app.post('/v1/projects', async (request, reply) => reply.code(201).send(projectDtoSchema.parse(await resources.createProject(identity(request), request.body))));
  app.get('/v1/projects', async request => ({ items: projectDtoSchema.array().parse(await resources.listProjects(identity(request), limit(request))) }));
  app.post('/v1/projects/:projectId/repositories', async (request, reply) => {
    const { projectId } = parseInput(projectParam, request.params);
    return reply.code(201).send(repositoryDtoSchema.parse(await resources.registerRepository(identity(request), projectId, request.body)));
  });
  app.get('/v1/projects/:projectId/repositories', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return { items: repositoryDtoSchema.array().parse(await resources.listRepositories(identity(request), projectId, limit(request))) };
  });
  app.post('/v1/projects/:projectId/applications', async (request, reply) => {
    const { projectId } = parseInput(projectParam, request.params);
    return reply.code(201).send(applicationDtoSchema.parse(await resources.createApplication(identity(request), projectId, request.body)));
  });
  app.get('/v1/projects/:projectId/applications', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return { items: applicationDtoSchema.array().parse(await resources.listApplications(identity(request), projectId, limit(request))) };
  });
  app.post('/v1/projects/:projectId/environments', async (request, reply) => {
    const { projectId } = parseInput(projectParam, request.params);
    return reply.code(201).send(environmentDtoSchema.parse(await resources.createEnvironment(identity(request), projectId, request.body)));
  });
  app.get('/v1/projects/:projectId/environments', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return { items: environmentDtoSchema.array().parse(await resources.listEnvironments(identity(request), projectId, limit(request))) };
  });
  app.post('/v1/tasks', async (request, reply) => {
    const result = admissionDtoSchema.parse(await tasks.admit(identity(request), request.body));
    return reply.code(result.replayed ? 200 : 202).send(result);
  });
  app.get('/v1/projects/:projectId/tasks', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return { items: taskDtoSchema.array().parse(await tasks.list(identity(request), projectId, limit(request))) };
  });
  app.get('/v1/tasks/:taskId', async request => {
    const { taskId } = parseInput(taskParam, request.params); return taskDtoSchema.parse(await tasks.get(identity(request), taskId));
  });
  app.get('/v1/tasks/:taskId/events', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return { items: taskEventDtoSchema.array().parse(await tasks.events(identity(request), taskId, limit(request))) };
  });
  app.post('/v1/tasks/:taskId/cancel', async request => {
    const { taskId } = parseInput(taskParam, request.params); return taskDtoSchema.parse(await tasks.cancel(identity(request), taskId, request.body));
  });
  return app;
}
