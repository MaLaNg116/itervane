import { createServer, type IncomingMessage } from 'node:http';
import type { AgentEvidence } from '@itervane/agent';

export const auditFixtureKey = 'itervane-native-fixture';
export const auditFixtureModel = 'itervane-native-audit';

async function auditContext(request: IncomingMessage): Promise<AgentEvidence[]> {
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
  const context = JSON.parse(first.content) as { observations: AgentEvidence[]; source?: unknown };
  if (context.source !== undefined || !Array.isArray(context.observations)) throw new Error('invalid fixture context');
  return context.observations;
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

export async function auditProtocolFixture() {
  let failAfterObservation = false;
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method !== 'POST' || request.url !== '/v1/messages' || request.headers.authorization !== `Bearer ${auditFixtureKey}`) {
        throw new Error('unexpected fixture request');
      }
      const observations = await auditContext(request);
      if (failAfterObservation && observations.length) {
        calls.push('unavailable');
        response.writeHead(503).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fixture unavailable' } }));
        return;
      }
      const selected = selectTool(observations);
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
