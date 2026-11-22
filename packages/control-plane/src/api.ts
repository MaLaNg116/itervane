import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  admissionDtoSchema, applicationDtoSchema, capabilitiesSchema, environmentDtoSchema,
  idSchema, listQuerySchema, meDtoSchema, projectAccessDtoSchema, portalConfigSchema, projectDtoSchema, repositoryDtoSchema, taskDtoSchema, taskEventDtoSchema,
  negotiateLocale, sourceInspectionDtoSchema, ruleIdSchema, ruleQuerySchema, preauditAdmissionSchema, preauditDtoSchema, sha256Schema, type Locale,
  operationsLaunchViewSchema, operationsRestartEnqueueInputSchema, operationsRestartSubmissionSchema,
  operationsRestartWriterProofSchema, type OperationsRestartWriterProof,
} from '@itervane/contracts';
import { AuthenticationError, createIdentityVerifier, type IdentityConfig, type VerifiedIdentity } from './auth/identity.js';
import type { Database } from './persistence/database.js';
import { DomainError, parseInput } from './service/errors.js';
import { errorCode, localizedError, statusFor } from './service/presentation.js';
import { ResourceService } from './service/resources.js';
import { TaskService } from './service/tasks.js';
import { createMcpEndpoint } from './mcp.js';
import { canonicalPublicUrl, type OperationsWorkflowScope } from './config.js';
import { registerPortal } from './portal.js';
import { InspectionService } from './service/inspections.js';
import { FormalAuditService } from './service/formal-audit.js';
import { FormalRepairService } from './service/repair-result.js';
import { FormalReleaseService } from './service/formal-release.js';
import { VerificationViewService } from './service/verification-view.js';
import { PreauditService, RuleService } from './service/preaudits.js';
import { OperationsObservationViewService } from './service/operations-observation-view.js';
import { OperationsDecisionService } from './service/operations-decisions.js';
import { OperationsProposalViewService } from './service/operations-proposal-view.js';
import { OperationsProposalService } from './service/operations-proposals.js';
import { OperationsExecutionAdmission } from './service/operations-execution-admission.js';
import { OperationsRestartViewService } from './service/operations-restart-view.js';
import { OperationsRestoreViewService } from './service/operations-restore-view.js';
import { ExecutionCoordinator } from './runtime/coordinator.js';
import { OperationsExecutionCoordinator } from './runtime/operations-execution-lease.js';

declare module 'fastify' {
  interface FastifyRequest { verifiedIdentity: VerifiedIdentity | null; locale: Locale }
  interface FastifyContextConfig { public?: boolean; mcp?: boolean }
}

const projectParam = z.object({ projectId: idSchema }).strict();
const taskParam = z.object({ taskId: idSchema }).strict();
const candidateParam = z.strictObject({ candidateId: idSchema });
const proposalParam = z.strictObject({ proposalId: idSchema });
const executionParam = z.strictObject({ executionId: idSchema });
const identity = (request: FastifyRequest) => {
  if (!request.verifiedIdentity) throw new AuthenticationError();
  return request.verifiedIdentity;
};
const limit = (request: FastifyRequest) => parseInput(listQuerySchema, request.query).limit;

export type ApiConfig = IdentityConfig & { publicUrl?: string; portalClientId?: string; operationsApi?: OperationsWorkflowScope };
export function createApi(database: Database, config: ApiConfig,
  options: { logger?: boolean; portalRoot?: string; operationsRestartWriter?: OperationsRestartWriterProof } = {}) {
  const verify = createIdentityVerifier(config);
  const resources = new ResourceService(database); const tasks = new TaskService(database);
  const inspections = new InspectionService(database); const audits = new FormalAuditService(database);
  const repairs = new FormalRepairService(database);
  const release = new FormalReleaseService(database, config.portalClientId);
  const verification = new VerificationViewService(database);
  const rules = new RuleService(database); const preaudits = new PreauditService(database);
  const app = Fastify({
    logger: options.logger === false ? false : { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }), requestIdHeader: false, genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024, requestTimeout: 15_000, connectionTimeout: 10_000,
    trustProxy: false, onProtoPoisoning: 'error', onConstructorPoisoning: 'error',
  });
  const mcp = createMcpEndpoint(database, config, () => app.log.error({ code: 'mcp_transport_error' }, 'mcp-request-failed'));
  app.addHook('onClose', () => mcp.close());
  app.decorateRequest('verifiedIdentity', null);
  app.decorateRequest('locale', 'en');
  app.addHook('onRequest', async request => {
    request.locale = negotiateLocale(request.headers['accept-language']);
    if (request.routeOptions.config.public) return;
    if (request.routeOptions.config.mcp) mcp.validateHeaders(request.headers);
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization)?.[1];
    if (!token) throw new AuthenticationError();
    request.verifiedIdentity = await (request.routeOptions.config.mcp ? mcp.verify : verify)(token);
    if (request.routeOptions.config.mcp && !mcp.hasScope(request.verifiedIdentity, 'itervane:read')) throw new DomainError('forbidden');
  });
  app.addHook('onSend', async (request, reply) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff').header('Content-Language', request.locale).header('Vary', 'Accept-Language');
  });
  app.addHook('onResponse', async (request, reply) => {
    app.log.info({ requestId: request.id, method: request.method, route: request.routeOptions.url, status: reply.statusCode }, 'request-completed');
  });
  app.setErrorHandler((error, request, reply) => {
    const code = errorCode(error);
    app.log[statusFor[code] >= 500 ? 'error' : 'warn']({ requestId: request.id, code }, 'request-failed');
    if (code === 'unauthenticated') reply.header('WWW-Authenticate', request.routeOptions.config.mcp ? mcp.challenge() : 'Bearer');
    if (code === 'forbidden' && request.routeOptions.config.mcp && request.verifiedIdentity && !mcp.hasScope(request.verifiedIdentity, mcp.requiredScope(request.body))) {
      reply.header('WWW-Authenticate', mcp.challenge(mcp.requiredScope(request.body)));
    }
    void reply.code(statusFor[code]).send(localizedError(code, request.id, request.locale));
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send(localizedError('not_found', request.id, request.locale)));
  const portalAvailable = registerPortal(app, options.portalRoot, config);
  const { operationsApi } = config;

  app.get('/health/live', { config: { public: true } }, async () => ({ status: 'alive' }));
  app.get('/portal-config', { config: { public: true } }, async () => {
    const origin = canonicalPublicUrl(config.publicUrl ?? 'http://127.0.0.1:4310');
    return portalConfigSchema.parse(config.portalClientId ? { enabled: true, authority: config.issuer, clientId: config.portalClientId,
      redirectUri: `${origin}/auth/callback`, postLogoutRedirectUri: `${origin}/auth/logout-callback` } : { enabled: false });
  });
  app.get('/.well-known/oauth-protected-resource/mcp', { config: { public: true } }, async () => mcp.metadata);
  app.route({ method: ['POST', 'GET', 'DELETE'], url: '/mcp', config: { mcp: true }, handler: async (request, reply) => {
    await mcp.handle(request, reply, identity(request), request.headers.authorization!.slice(7));
  } });
  app.get('/v1/me', async request => meDtoSchema.parse(await resources.me(identity(request))));
  app.get('/v1/capabilities', async request => {
    await resources.me(identity(request));
    const stage = operationsApi?.diagnosisProviderSha256 ? 'p3-b' : operationsApi ? 'p3-a' : 'p1-e';
    return capabilitiesSchema.parse({ stage, taskAdmission: true, taskExecution: false, durableScheduling: true, externalMcp: true,
      ruleQuery: true, limitedTextPreaudit: true, autonomousAgents: false,
      sourceInspectionPlanning: true, sourceSnapshots: false, sourceScanning: false,
      portal: portalAvailable, browserLogin: portalAvailable && Boolean(config.portalClientId), sandbox: false, deployment: false, operations: Boolean(operationsApi) });
  });
  app.post('/v1/projects', async (request, reply) => reply.code(201).send(projectDtoSchema.parse(await resources.createProject(identity(request), request.body))));
  app.get('/v1/projects', async request => ({ items: projectDtoSchema.array().parse(await resources.listProjects(identity(request), limit(request))) }));
  app.get('/v1/projects/:projectId', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return projectDtoSchema.parse(await resources.getProject(identity(request), projectId));
  });
  app.get('/v1/projects/:projectId/access', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return projectAccessDtoSchema.parse(await resources.projectAccess(identity(request), projectId));
  });
  app.get('/v1/projects/:projectId/rules', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return rules.list(identity(request), projectId, request.query, request.locale);
  });
  app.get('/v1/projects/:projectId/rules/:ruleId', async request => {
    const { projectId, ruleId } = parseInput(projectParam.extend({ ruleId: ruleIdSchema }), request.params);
    return rules.get(identity(request), projectId, ruleId, parseInput(ruleQuerySchema, request.query), request.locale);
  });
  app.post('/v1/preaudits', async (request, reply) => {
    const result = preauditAdmissionSchema.parse(await preaudits.create(identity(request), request.body, 'http', request.locale));
    return reply.code(result.replayed ? 200 : 201).send(result);
  });
  app.get('/v1/preaudits/:preauditId', async request => {
    const { preauditId } = parseInput(z.object({ preauditId: idSchema }).strict(), request.params);
    return preauditDtoSchema.parse(await preaudits.get(identity(request), preauditId, request.locale));
  });
  app.get('/v1/projects/:projectId/preaudits', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return { items: await preaudits.list(identity(request), projectId, limit(request)) };
  });
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
  if (operationsApi) {
    const operations = new OperationsObservationViewService(database);
    app.post('/v1/operations/diagnoses', async (request, reply) => {
      const result = admissionDtoSchema.parse(await tasks.admitOperations(identity(request), request.body, operationsApi));
      return reply.code(result.replayed ? 200 : 202).send(result);
    });
    app.get('/v1/tasks/:taskId/operations', async request => {
      const { taskId } = parseInput(taskParam, request.params);
      return operations.get(identity(request), taskId, request.locale);
    });
    app.get('/v1/tasks/:taskId/operations-option', async request => {
      const { taskId } = parseInput(taskParam, request.params);
      return operationsLaunchViewSchema.parse(await operations.getLaunchOption(identity(request), taskId, operationsApi));
    });
  }
  if (operationsApi?.diagnosisProviderSha256) {
    const proposals = new OperationsProposalService(database, operationsApi);
    const decisions = new OperationsDecisionService(database, operationsApi, config.portalClientId);
    const views = new OperationsProposalViewService(database, operationsApi, config.portalClientId);
    const restartOperator = config.portalClientId && options.operationsRestartWriter
      ? { clientId: config.portalClientId, writer: operationsRestartWriterProofSchema.parse(options.operationsRestartWriter) }
      : undefined;
    const restarts = new OperationsRestartViewService(database, operationsApi, restartOperator);
    const restores = new OperationsRestoreViewService(database);
    app.get('/v1/tasks/:taskId/operations-proposal', async request => {
      const { taskId } = parseInput(taskParam, request.params);
      return views.get(identity(request), taskId, request.locale);
    });
    app.post('/v1/tasks/:taskId/operations-proposal', async (request, reply) => {
      const { taskId } = parseInput(taskParam, request.params);
      const { replayed } = await proposals.freeze(identity(request), taskId, request.body);
      return reply.code(replayed ? 200 : 201).send(await views.get(identity(request), taskId, request.locale));
    });
    app.post('/v1/operations/proposals/:proposalId/decisions', async request => {
      const { proposalId } = parseInput(proposalParam, request.params);
      const { taskId } = await decisions.decide(identity(request), proposalId, request.body);
      return views.get(identity(request), taskId, request.locale);
    });
    app.get('/v1/tasks/:taskId/operations-execution', async request => {
      const { taskId } = parseInput(taskParam, request.params);
      return restarts.get(identity(request), taskId, request.locale);
    });
    app.get('/v1/tasks/:taskId/operations-restore', async request => {
      const { taskId } = parseInput(taskParam, request.params);
      return restores.get(identity(request), taskId, request.locale);
    });
    if (restartOperator) {
      const admission = new OperationsExecutionAdmission(database, operationsApi);
      const coordinator = new OperationsExecutionCoordinator(new ExecutionCoordinator(database), operationsApi, restartOperator.clientId);
      app.post('/v1/operations/proposals/:proposalId/execution', async (request, reply) => {
        const { proposalId } = parseInput(proposalParam, request.params);
        const input = parseInput(operationsRestartEnqueueInputSchema, request.body);
        const { execution, replayed } = await admission.enqueue({ ...input, proposalId }, { ...restartOperator, identity: identity(request) });
        return reply.code(replayed ? 200 : 202).send(operationsRestartSubmissionSchema.parse({ executionId: execution.id, replayed }));
      });
      app.post('/v1/operations/executions/:executionId/continue', async (request, reply) => {
        const { executionId } = parseInput(executionParam, request.params);
        const { replayed } = await coordinator.requestRestartResume(identity(request), executionId, request.body, restartOperator.writer);
        return reply.code(replayed ? 200 : 202).send(operationsRestartSubmissionSchema.parse({ executionId, replayed }));
      });
    }
  }
  app.get('/v1/projects/:projectId/tasks', async request => {
    const { projectId } = parseInput(projectParam, request.params);
    return { items: taskDtoSchema.array().parse(await tasks.list(identity(request), projectId, limit(request))) };
  });
  app.get('/v1/tasks/:taskId', async request => {
    const { taskId } = parseInput(taskParam, request.params); return taskDtoSchema.parse(await tasks.get(identity(request), taskId));
  });
  app.get('/v1/tasks/:taskId/events', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return { items: taskEventDtoSchema.array().parse(await tasks.events(identity(request), taskId, limit(request), request.locale)) };
  });
  app.get('/v1/tasks/:taskId/source-inspection', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return sourceInspectionDtoSchema.parse(await inspections.get(identity(request), taskId));
  });
  app.get('/v1/tasks/:taskId/audit', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return audits.get(identity(request), taskId, request.locale);
  });
  app.get('/v1/tasks/:taskId/repair', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return repairs.get(identity(request), taskId, request.locale);
  });
  app.get('/v1/tasks/:taskId/repair/patch', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    const { expectedSha256 } = parseInput(z.strictObject({ expectedSha256: sha256Schema }), request.query);
    return repairs.exportPatch(identity(request), taskId, expectedSha256);
  });
  app.get('/v1/tasks/:taskId/verification', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return verification.get(identity(request), taskId, request.locale);
  });
  app.get('/v1/tasks/:taskId/release', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return release.getView(identity(request), taskId, request.locale);
  });
  app.get('/v1/tasks/:taskId/release-candidate', async request => {
    const { taskId } = parseInput(taskParam, request.params);
    return release.get(identity(request), taskId, request.locale);
  });
  app.post('/v1/tasks/:taskId/release-candidate', async (request, reply) => {
    const { taskId } = parseInput(taskParam, request.params);
    const { candidate, replayed } = await release.freeze(identity(request), taskId, request.body, request.locale);
    return reply.code(replayed ? 200 : 201).send(candidate);
  });
  app.post('/v1/release-candidates/:candidateId/decisions', async request => {
    const { candidateId } = parseInput(candidateParam, request.params);
    return release.decide(identity(request), candidateId, request.body, request.locale);
  });
  app.post('/v1/tasks/:taskId/cancel', async request => {
    const { taskId } = parseInput(taskParam, request.params); return taskDtoSchema.parse(await tasks.cancel(identity(request), taskId, request.body));
  });
  app.post('/v1/tasks/:taskId/resume', async request => {
    const { taskId } = parseInput(taskParam, request.params); return taskDtoSchema.parse(await tasks.resume(identity(request), taskId, request.body));
  });
  return app;
}
