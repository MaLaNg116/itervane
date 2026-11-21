import { randomUUID } from 'node:crypto';
import { Server, createMcpHandler, isSpecType, type CallToolResult } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cancelTaskSchema, formalReleaseOptionsSchema, formalReleaseResultSchema, freezeFormalReleaseSchema, idSchema, listQuerySchema, preauditInputSchema,
  resumeTaskSchema, ruleIdSchema, ruleQuerySchema, startTaskSchema, translate, type Locale } from '@itervane/contracts';
import { assertVerifiedIdentity, AuthenticationError, createIdentityVerifier, type IdentityConfig, type VerifiedIdentity } from './auth/identity.js';
import { canonicalPublicUrl } from './config.js';
import type { Database } from './persistence/database.js';
import { DomainError, parseInput } from './service/errors.js';
import { errorCode, localizedError } from './service/presentation.js';
import { ResourceService } from './service/resources.js';
import { TaskService } from './service/tasks.js';
import { InspectionService } from './service/inspections.js';
import { FormalAuditService } from './service/formal-audit.js';
import { FormalRepairService } from './service/repair-result.js';
import { VerificationViewService } from './service/verification-view.js';
import { FormalReleaseService } from './service/formal-release.js';
import { PreauditService, RuleService } from './service/preaudits.js';

const taskIdInput = z.object({ taskId: idSchema }).strict();
const versionInput = cancelTaskSchema.extend({ taskId: idSchema }).strict();
const resumeInput = resumeTaskSchema.extend({ taskId: idSchema }).strict();
const releaseRequestInput = freezeFormalReleaseSchema.extend({ taskId: idSchema });
const eventsInput = listQuerySchema.extend({ taskId: idSchema }).strict();
const ruleListInput = ruleQuerySchema.extend({ projectId: idSchema }).strict();
const ruleGetInput = ruleListInput.extend({ ruleId: ruleIdSchema }).strict();
const preauditGetInput = z.object({ preauditId: idSchema }).strict();
const preauditListInput = listQuerySchema.extend({ projectId: idSchema }).strict();
const specs = [
  { name: 'start_audit', key: 'mcp.start', input: startTaskSchema, write: true },
  { name: 'get_task', key: 'mcp.query', input: taskIdInput, write: false },
  { name: 'get_task_events', key: 'mcp.events', input: eventsInput, write: false },
  { name: 'get_source_inspection', key: 'mcp.inspection', input: taskIdInput, write: false },
  { name: 'get_audit', key: 'mcp.audit', input: taskIdInput, write: false },
  { name: 'get_repair', key: 'mcp.repair', input: taskIdInput, write: false },
  { name: 'get_verification', key: 'mcp.verification', input: taskIdInput, write: false },
  { name: 'get_release_candidate', key: 'mcp.release_candidate', input: taskIdInput, write: false },
  { name: 'get_release_options', key: 'mcp.release_options', input: taskIdInput, write: false },
  { name: 'get_release_result', key: 'mcp.release_result', input: taskIdInput, write: false },
  { name: 'request_release', key: 'mcp.request_release', input: releaseRequestInput, write: true },
  { name: 'cancel_task', key: 'mcp.cancel', input: versionInput, write: true },
  { name: 'resume_task', key: 'mcp.resume', input: resumeInput, write: true },
  { name: 'list_rules', key: 'mcp.rules', input: ruleListInput, write: false },
  { name: 'get_rule', key: 'mcp.rule', input: ruleGetInput, write: false },
  { name: 'preaudit_text', key: 'mcp.preaudit', input: preauditInputSchema, write: true },
  { name: 'get_preaudit', key: 'mcp.preaudit_query', input: preauditGetInput, write: false },
  { name: 'list_preaudits', key: 'mcp.preaudits', input: preauditListInput, write: false },
] as const;

export function createMcpEndpoint(database: Database, config: IdentityConfig & { publicUrl?: string }, onerror: () => void) {
  const publicUrl = canonicalPublicUrl(config.publicUrl ?? 'http://127.0.0.1:4310');
  const resource = `${publicUrl}/mcp`; const metadataUrl = `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const verify = createIdentityVerifier({ issuer: config.issuer, audience: resource });
  const service = new TaskService(database); const resources = new ResourceService(database);
  const inspections = new InspectionService(database); const audits = new FormalAuditService(database);
  const repairs = new FormalRepairService(database);
  const verification = new VerificationViewService(database);
  const release = new FormalReleaseService(database);
  const rules = new RuleService(database); const preaudits = new PreauditService(database);
  const allowedHosts = new Set([new URL(publicUrl).hostname, 'localhost', '127.0.0.1', '[::1]']);
  const requiredScope = (body: unknown) => {
    const parsed = z.object({ method: z.string(), params: z.object({ name: z.string() }).passthrough().optional() }).passthrough().safeParse(body);
    return parsed.success && parsed.data.method === 'tools/call' && specs.some(tool => tool.name === parsed.data.params?.name && tool.write)
      ? 'itervane:write' : 'itervane:read';
  };
  const hasScope = (identity: VerifiedIdentity, scope: string) => identity.scopes.includes('itervane:read') && identity.scopes.includes(scope);
  const handler = createMcpHandler(ctx => {
    const identity = ctx.authInfo?.extra?.identity as VerifiedIdentity | undefined;
    if (!identity) throw new AuthenticationError();
    assertVerifiedIdentity(identity);
    const locale = ctx.authInfo?.extra?.locale as Locale;
    const requestId = ctx.authInfo?.extra?.requestId as string;
    const server = new Server({ name: 'itervane', version: '0.0.0' }, { capabilities: { tools: {} } });
    server.onerror = onerror;
    server.setRequestHandler('tools/list', async () => ({ tools: specs.filter(tool => !tool.write || hasScope(identity, 'itervane:write')).map(tool => {
      const definition = { name: tool.name, description: translate(locale, tool.key), inputSchema: z.toJSONSchema(tool.input, { io: 'input' }),
        annotations: { readOnlyHint: !tool.write, destructiveHint: false, idempotentHint: tool.name !== 'resume_task', openWorldHint: false } };
      if (!isSpecType.Tool(definition)) throw new Error('Invalid MCP tool catalog');
      return definition;
    }) }));
    server.setRequestHandler('tools/call', async request => {
      let result: CallToolResult;
      try {
        const spec = specs.find(tool => tool.name === request.params.name);
        if (!spec) throw new DomainError('not_found');
        if (!hasScope(identity, spec.write ? 'itervane:write' : 'itervane:read')) throw new DomainError('forbidden');
        // 在领域入口做同样的严格验证；不把 Zod 原始详情或请求内容泄露给客户端。
        parseInput<unknown>(spec.input, request.params.arguments ?? {});
        const args = request.params.arguments ?? {};
        let output: Record<string, unknown>;
        switch (spec.name) {
          case 'start_audit': output = await service.admit(identity, args); break;
          case 'get_task': output = await service.get(identity, taskIdInput.parse(args).taskId); break;
          case 'get_source_inspection': output = await inspections.get(identity, taskIdInput.parse(args).taskId); break;
          case 'get_audit': output = await audits.get(identity, taskIdInput.parse(args).taskId, locale); break;
          case 'get_repair': output = await repairs.get(identity, taskIdInput.parse(args).taskId, locale); break;
          case 'get_verification': output = await verification.get(identity, taskIdInput.parse(args).taskId, locale); break;
          case 'get_release_candidate': output = await release.get(identity, taskIdInput.parse(args).taskId, locale); break;
          case 'get_release_options': {
            const { taskId, runId, taskVersion, availableTargets } = await release.getView(identity, taskIdInput.parse(args).taskId, locale);
            output = formalReleaseOptionsSchema.parse({ taskId, runId, taskVersion, availableTargets }); break;
          }
          case 'get_release_result': {
            const { taskId, runId, taskVersion, result: releaseResult } = await release.getView(identity, taskIdInput.parse(args).taskId, locale);
            output = formalReleaseResultSchema.parse({ taskId, runId, taskVersion, result: releaseResult }); break;
          }
          case 'request_release': {
            const { taskId, ...input } = releaseRequestInput.parse(args);
            output = (await release.freeze(identity, taskId, input, locale)).candidate; break;
          }
          case 'list_rules': { const { projectId, ...query } = ruleListInput.parse(args); output = await rules.list(identity, projectId, query, locale); break; }
          case 'get_rule': { const { projectId, ruleId, ...query } = ruleGetInput.parse(args); output = await rules.get(identity, projectId, ruleId, query, locale); break; }
          case 'preaudit_text': output = await preaudits.create(identity, args, 'mcp', locale); break;
          case 'get_preaudit': output = await preaudits.get(identity, preauditGetInput.parse(args).preauditId, locale); break;
          case 'list_preaudits': { const { projectId, limit } = preauditListInput.parse(args); output = { items: await preaudits.list(identity, projectId, limit) }; break; }
          case 'get_task_events': {
            const input = eventsInput.parse(args); output = { items: await service.events(identity, input.taskId, input.limit, locale) }; break;
          }
          case 'cancel_task': { const { taskId, expectedVersion } = versionInput.parse(args); output = await service.cancel(identity, taskId, { expectedVersion }); break; }
          case 'resume_task': { const { taskId, expectedVersion } = resumeInput.parse(args); output = await service.resume(identity, taskId, { expectedVersion }); break; }
        }
        result = { content: [{ type: 'text', text: translate(locale, 'mcp.result') }], structuredContent: output };
      } catch (error) {
        const response = localizedError(errorCode(error), requestId, locale);
        result = { isError: true, content: [{ type: 'text', text: response.error.message }], structuredContent: response };
      }
      return server.projectCallToolResult(result, undefined);
    });
    return server;
  }, { maxRequestBodySize: 64 * 1024, onerror });
  const node = toNodeHandler(handler, { maxRequestBodySize: 64 * 1024, onerror });
  return {
    verify, requiredScope, hasScope,
    metadata: { resource, authorization_servers: [config.issuer], bearer_methods_supported: ['header'], scopes_supported: ['itervane:read', 'itervane:write'] },
    challenge(scope?: string) { return `Bearer resource_metadata="${metadataUrl}"${scope ? `, error="insufficient_scope", scope="${scope}"` : ''}`; },
    validateHeaders(headers: FastifyRequest['headers']) {
      try {
        const host = typeof headers.host === 'string' ? new URL(`http://${headers.host}`) : undefined;
        if (!host || host.username || host.password || host.pathname !== '/' || host.search || host.hash || !allowedHosts.has(host.hostname)) throw new Error();
        if (headers.origin !== undefined && headers.origin !== publicUrl) throw new Error();
      } catch { throw new DomainError('forbidden'); }
    },
    async handle(request: FastifyRequest, reply: FastifyReply, identity: VerifiedIdentity, token: string) {
      if (!hasScope(identity, requiredScope(request.body))) throw new DomainError('forbidden');
      await resources.me(identity);
      reply.raw.setHeader('Cache-Control', 'no-store'); reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
      reply.raw.setHeader('Content-Language', request.locale); reply.raw.setHeader('Vary', 'Accept-Language');
      reply.hijack();
      await node({ method: request.method, url: '/mcp', headers: request.headers,
        auth: { token, clientId: identity.clientId, scopes: [...identity.scopes], expiresAt: identity.expiresAt,
          resource: new URL(resource), resourceMetadataUrl: metadataUrl, extra: { identity, locale: request.locale, requestId: request.id ?? randomUUID() } },
        [Symbol.asyncIterator]: () => request.raw[Symbol.asyncIterator](),
      }, reply.raw, request.body);
    },
    close: () => handler.close(),
  };
}
