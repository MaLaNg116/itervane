import { createServer, type IncomingMessage } from 'node:http';
import { agentText, type AgentEvidence } from '@itervane/agent';
import { formalRepairRetryContextSchema } from '@itervane/contracts';
import { verificationFixtureCall } from '../../../verification/src/agent/verification-fixture.js';
import { npmReleaseApproval } from '../../../verification/src/native/npm-release-fixture.js';

export const auditFixtureKey = 'itervane-native-fixture';
export const auditFixtureModel = 'itervane-native-audit';

async function auditContext(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error('fixture request exceeded limit');
    chunks.push(bytes);
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; messages?: Array<{ role: string; content: unknown }> };
  const first = payload.messages?.[0];
  if (payload.model !== auditFixtureModel || first?.role !== 'user' || typeof first.content !== 'string') throw new Error('invalid fixture envelope');
  const context = JSON.parse(first.content) as { observations: AgentEvidence[]; source?: unknown; role?: unknown; goal?: unknown;
    handoff?: { findings?: Array<{ id: string; scanner: string; ruleId: string }>; previousVerification?: unknown } };
  if (context.source !== undefined || !Array.isArray(context.observations)) throw new Error('invalid fixture context');
  return context;
}

function selectTool(observations: AgentEvidence[]) {
  const scans = observations.flatMap(item => item.data.kind === 'scan' ? [{ ...item.data, id: item.id }] : []);
  const secrets = scans.find(scan => scan.scanner === 'gitleaks');
  if (!secrets) return { name: 'read_scan', input: { scanner: 'gitleaks' } };
  if (secrets.findings.length && !observations.some(item => item.data.kind === 'rule')) {
    return { name: 'read_rule', input: { ruleId: 'bounded-review-context' } };
  }
  if (!scans.some(scan => scan.scanner === 'trivy')) return { name: 'read_scan', input: { scanner: 'trivy' } };
  return { name: 'finish_role', input: {
    summary: '已核对隔离扫描的证据和覆盖。', evidenceIds: observations.map(item => item.id),
    explanations: scans.flatMap(scan => scan.findings.map(item => ({ findingId: item.id,
      impact: scan.scanner === 'gitleaks' ? '敏感模式需要所有者确认。' : '依赖命中固定公告，需要核对受影响版本。',
      suggestion: scan.scanner === 'gitleaks' ? '确认影响范围并按需更换凭据。' : '核对升级路径并复验受影响依赖。',
    }))),
  } };
}

function selectOperations(observations: AgentEvidence[]) {
  const readings = observations.flatMap(({ id, data }) => data.kind === 'operations_section' ? [{ id, data }] : []);
  for (const section of ['container', 'release', 'logs', 'metrics'] as const) {
    const observed = readings.find(item => item.data.section === section);
    if (!observed) return { name: 'read_operations', input: { section } };
    if ('containerId' in observed.data.result || 'serverId' in observed.data.result) throw new Error('operations_fixture_private_target');
  }
  return { name: 'finish_role', input: { hypotheses: [], recommendation: { code: 'continue_observation',
    evidenceIds: readings.filter(item => item.data.section === 'container' || item.data.section === 'release').map(item => item.id) } } };
}

function selectRetryRepair(observations: AgentEvidence[], handoff: Awaited<ReturnType<typeof auditContext>>['handoff']) {
  const candidate = observations.find(item => item.data.kind === 'repair_candidate');
  if (candidate) return { name: 'finish_role', input: { evidenceId: candidate.id, summary: '已提交候选修改并等待独立复验。' } };
  const finding = handoff?.findings?.find(item => item.scanner === 'gitleaks' && item.ruleId === 'generic-api-key');
  if (!finding || handoff?.findings?.length !== 1) throw new Error('retry_fixture_finding');
  const observation = observations.find(item => item.data.kind === 'repair_targets');
  if (observation?.data.kind !== 'repair_targets') return { name: 'read_repair_targets', input: { findingIds: [finding.id] } };
  const target = observation.data.observation.targets[0];
  if (target?.findingId !== finding.id || !target.range) throw new Error('retry_fixture_range');
  const { startByte, endByte } = target.range;
  const previous = formalRepairRetryContextSchema.optional().parse(handoff?.previousVerification);
  if (previous && (previous.failure.outcome !== 'checks_failed'
      || !previous.failure.checks.some(check => check.id === 'health' && check.statusCode === 503))) throw new Error('retry_fixture_failure');
  const replacement = previous
    ? "    response.status(mode === 'healthy' ? 200 : 503).json({ status: mode, version });\n"
    : "    response.status(503).json({ status: 'unhealthy', version });\n";
  return { name: 'apply_repair_patch', input: { observationId: observation.id, targets: [{ targetIndex: 0,
    edits: [{ startByte, endByte, replacement }],
  }] } };
}

function selectDependencyRepair(observations: AgentEvidence[], handoff: Awaited<ReturnType<typeof auditContext>>['handoff']) {
  const candidate = observations.find(item => item.data.kind === 'repair_candidate');
  if (candidate) return { name: 'finish_role', input: { evidenceId: candidate.id, summary: '已提交成对依赖修复并等待复验。' } };
  const findings = handoff?.findings;
  const finding = findings?.find(item => item.scanner === 'trivy' && item.ruleId === npmReleaseApproval.advisoryId);
  if (!finding || findings?.length !== 1) throw new Error('npm_release_finding');
  const observed = observations.find(item => item.data.kind === 'repair_targets');
  if (observed?.data.kind !== 'repair_targets') return { name: 'read_repair_targets', input: { findingIds: [finding.id] } };
  const { targets } = observed.data.observation;
  if (targets.length !== 2 || targets.some(target => target.findingId !== finding.id ||
      target.npm?.name !== npmReleaseApproval.name || target.npm.fixedVersion !== npmReleaseApproval.fixedVersion)) {
    throw new Error('npm_release_targets');
  }
  return { name: 'apply_repair_patch', input: { observationId: observed.id, targets: targets.map((_, targetIndex) => ({ targetIndex })) } };
}

export async function auditProtocolFixture(options: { repairRetry?: boolean; dependencyRepair?: boolean } = {}) {
  let failAfterObservation = false;
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method !== 'POST' || request.url !== '/v1/messages' || request.headers.authorization !== `Bearer ${auditFixtureKey}`) {
        throw new Error('unexpected fixture request');
      }
      const { observations, role, goal, handoff } = await auditContext(request);
      if (failAfterObservation && observations.length) {
        calls.push('unavailable');
        response.writeHead(503).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fixture unavailable' } }));
        return;
      }
      const locale = goal === agentText('zh-CN').formalVerification.goal ? 'zh-CN' : 'en';
      const selected = role === 'verify' ? verificationFixtureCall(observations, locale)
        : role === 'operations' ? selectOperations(observations)
        : role === 'repair' && options.dependencyRepair ? selectDependencyRepair(observations, handoff)
        : role === 'repair' && options.repairRetry ? selectRetryRepair(observations, handoff) : selectTool(observations);
      calls.push(selected.name);
      response.end(JSON.stringify({
        id: `msg_fixture_${calls.length}`, type: 'message', role: 'assistant', model: auditFixtureModel,
        content: [{ type: 'tool_use', id: `toolu_fixture_${calls.length}`, ...selected }], stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 35, output_tokens: 12 },
      }));
    } catch {
      calls.push('invalid_request');
      response.writeHead(400).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture request rejected' } }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture address missing');
  return { baseURL: `http://127.0.0.1:${address.port}`, calls,
    fail() { failAfterObservation = true; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
