import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, expect, type Browser } from '@playwright/test';
import { localeSchema, type Check } from '@itervane/contracts';
import { WhiskersObservationClient, WhiskersObservationError } from '../../../control-plane/src/runtime/whiskers-observation.js';
import { WhiskersRestartClient, WhiskersRestartError } from '../../../control-plane/src/runtime/whiskers-restart.js';
import { confirmationId, toolText, WhiskersProbeClient, whiskersOrigin, whiskersVersion } from '../../../verification/src/native/whiskers.js';
import { executeProbe, report } from '../../../verification/src/report.js';
import { eligibleHost, operatorEmail, WhiskersFixture } from './whiskers-fixture.js';
import { approveRestart, NativeBrowserFailure, observeRestartAudit, signIn } from './whiskers-ui.js';

const messages = {
  host: ['Use an isolated GitHub-hosted Linux test machine.', '需要独立的 GitHub 托管 Linux 测试机。'],
  observe: ['The authenticated MCP observation matched the running fixture.', '已认证的 MCP 观察与实际样例一致。'],
  'operator-policy': ['The native Operator could open Approvals. Guardrail management required an Admin.', '原生 Operator 可进入审批界面，护栏配置仅对管理员开放。'],
  'scoped-writer': ['The restart adapter rejected the broader Write key before requesting an action.', '重启适配器在申请操作前拒绝了超出单工具范围的写凭证。'],
  pending: ['The first restart request entered native approval and left the actual fixture unchanged.', '首次重启请求进入原生审批，样例运行状态未变化。'],
  approved: ['The browser approver confirmed the exact request. The fixture still awaited execution.', '浏览器身份确认了原请求，样例仍等待执行。'],
  binding: ['Changing either the caller or the target required a separate native approval.', '更换调用身份或目标均要求新的原生审批。'],
  applied: ['The identical request after reconnect restarted only the approved container, and its HTTP health responded.', '重连后同参请求只重启了已批准容器，其 HTTP 健康检查通过。'],
  consumed: ['A further call required a fresh approval. The previous grant was used once.', '再次调用需要新审批，之前的授权仅执行了一次。'],
  audit: ['The native audit view recorded a single restart for the expected actor and target.', '原生审计视图仅记录一次重启，调用身份与目标匹配。'],
  'bound-observe-running': ['The production adapter used a native Read key and returned only the bound runtime facts.', '正式适配器使用原生只读密钥，只返回已绑定目标的运行事实。'],
  'bound-observe-stopped': ['The bound container was observed as exited after the fixture stopped it.', '停止测试容器后，正式适配器观察到同一绑定容器已退出。'],
  'bound-observe-unknown': ['A missing full container ID could not produce an observation.', '完整容器 ID 不存在时，未形成有效观察。'],
  'bound-observe-timeout': ['The paused service hit its deadline. A fresh observation succeeded after resuming the fixture.', '服务暂停时观察按时限中止。恢复服务后重新观察成功。'],
  'bound-log-signals': ['The native log tail for the stopped container was projected to signal counts.', '已停止容器的原生日志经投影后只保留信号计数。'],
  'bound-metrics-present': ['The installed metrics collector recorded samples for the running container.', '原生指标采集器已为运行中的绑定容器记录样本。'],
  'bound-metrics-unavailable': ['An ID without history returned explicit missing coverage.', '没有指标历史的容器 ID 返回明确的未覆盖状态。'],
  stopped: ['Verification stopped at', '验证中止于'],
  clean: ['Temporary containers and password file were removed.', '已清理临时容器和口令文件。'],
} as const;

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error('Missing native evidence');
}

async function requireObservationError(call: Promise<unknown>, reason: WhiskersObservationError['reason']) {
  try { await call; }
  catch (error) {
    if (error instanceof WhiskersObservationError && error.reason === reason) return;
    throw error;
  }
  throw new Error('Unexpected observation');
}

async function run() {
  const chinese = localeSchema.catch('en').parse(process.env.ITERVANE_NATIVE_LOCALE) === 'zh-CN';
  const language = chinese ? 1 : 0;
  const checks: Check[] = [];
  const finish = () => report('whiskers-native', checks);
  if (!eligibleHost()) {
    checks.push({ id: 'dedicated-host', status: 'blocked', detail: messages.host[language] });
    return finish();
  }
  const record = (id: keyof typeof messages, detail = '') => checks.push({
    id, status: 'passed', detail: messages[id][language] + detail,
  });
  const fixture = new WhiskersFixture();
  let browser: Browser | undefined;
  const clients = new Set<WhiskersProbeClient>();
  let step = 'fixture-start';

  async function connect(key: string) {
    const client = new WhiskersProbeClient();
    clients.add(client);
    await client.connect(key);
    return client;
  }

  try {
    await fixture.start();
    step = 'fixture-baseline';
    const a = await fixture.snapshot(fixture.primary);
    const b = await fixture.snapshot(fixture.other);
    requireProof(a.id !== b.id && await fixture.healthy(fixture.primary) && await fixture.healthy(fixture.other));

    async function unchanged(beforeA = a.started) {
      const currentA = await fixture.snapshot(fixture.primary);
      const currentB = await fixture.snapshot(fixture.other);
      return currentA.id === a.id && currentB.id === b.id && currentA.started === beforeA && currentB.started === b.started;
    }

    step = 'browser-launch';
    browser = await chromium.launch({ channel: 'chrome' });
    const page = await browser.newPage({ locale: 'en-US' });
    page.setDefaultTimeout(14_000);
    await page.route('**/*', route => new URL(route.request().url()).origin === whiskersOrigin ? route.continue() : route.abort());
    step = 'browser-login';
    await signIn(page, fixture.operatorPassword, operatorEmail);

    step = 'operator-policy';
    await page.goto(whiskersOrigin + '/guardrails', { waitUntil: 'domcontentloaded' });
    await expect(page.getByText('Only admins can change the guardrails.', { exact: true })).toBeVisible();
    await page.goto(whiskersOrigin + '/approvals', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
    record('operator-policy');

    const { primary: key, alternate: alternateKey, broad } = fixture.writers;
    const { readKey } = fixture;
    step = 'native-mcp-connect';
    const client = await connect(key);
    const alternateClient = await connect(alternateKey);
    step = 'mcp-observe';
    const observed = await (await connect(readKey)).observe(a.id);
    const observedText = toolText(observed);
    requireProof(!observed.isError && observedText?.includes('ID: ' + a.id) && observedText.includes('State: running'));
    record('observe', ' Whiskers ' + whiskersVersion + '.');

    const target = { origin: whiskersOrigin, serverId: 'local', containerId: a.id };
    const restart = new WhiskersRestartClient(target, key);
    let allowedApproval: string | undefined;
    const authorizeRestart: Parameters<WhiskersRestartClient['requestApproval']>[0] = async (_phase, attempt, target) => {
      requireProof(target.origin === whiskersOrigin && target.serverId === 'local' && target.containerId === a.id
        && (attempt.kind !== 'resume' || attempt.approvalId === allowedApproval));
    };
    step = 'scoped-writer';
    await expect(new WhiskersRestartClient(target, broad).requestApproval(authorizeRestart)).rejects.toMatchObject({ reason: 'binding' });
    requireProof(await unchanged());
    record('scoped-writer');

    step = 'pending-confirmation';
    const request = await restart.requestApproval(authorizeRestart);
    requireProof(request.status === 'awaiting_approval' && await unchanged());
    const id = allowedApproval = request.approvalId;
    const pending = await restart.resume(id, authorizeRestart);
    requireProof(pending.status === 'awaiting_approval' && pending.approvalId === id && await unchanged());
    record('pending', ' Approval=' + id + '.');

    step = 'browser-approval';
    await approveRestart(page, a.id, operatorEmail);
    requireProof(await unchanged());
    record('approved', ' Approval=' + id + '.');

    step = 'approval-binding';
    const differentCaller = confirmationId(await alternateClient.restart(a.id));
    const differentTarget = confirmationId(await client.restart(b.id));
    requireProof(differentCaller && differentTarget && new Set([id, differentCaller, differentTarget]).size === 3 && await unchanged());
    record('binding', ' Approvals=' + differentCaller + ',' + differentTarget + '.');

    step = 'approved-reconnect';
    await client.close();
    clients.delete(client);
    step = 'approved-dispatch';
    // Exactly one dispatch after approval. An error leads to a read-only
    // observation of the actual fixture and exits without redispatch.
    const result = await restart.resume(id, authorizeRestart);
    const restarted = await fixture.snapshot(fixture.primary);
    requireProof(result.status === 'acknowledged' && result.approvalId === id
      && restarted.id === a.id && Date.parse(restarted.started) > Date.parse(a.started)
      && await unchanged(restarted.started) && await fixture.healthy(fixture.primary));
    record('applied');

    step = 'used-approval';
    const replay = await restart.requestApproval(authorizeRestart);
    requireProof(replay.status === 'awaiting_approval' && ![id, differentCaller, differentTarget].includes(replay.approvalId)
      && await unchanged(restarted.started));
    record('consumed', ' Approval=' + replay.approvalId + '.');

    step = 'native-restart-audit';
    await observeRestartAudit(page, fixture.primary, fixture.primaryWriter);
    record('audit');

    const nativeObserver = (containerId: string) => new WhiskersObservationClient({ origin: whiskersOrigin, serverId: 'local', containerId }, readKey);
    const authorized = async () => {};
    step = 'bound-observe-running';
    const observer = nativeObserver(a.id);
    const running = await observer.observe(authorized);
    requireProof(Object.keys(running).length === 4 && running.containerId === a.id && running.serverId === 'local'
      && running.state === 'running' && Number.isFinite(Date.parse(running.observedAt)) && await unchanged(restarted.started));
    record('bound-observe-running');

    step = 'bound-observe-stopped';
    await fixture.stopOther();
    const stopped = await nativeObserver(b.id).observe(authorized);
    requireProof(stopped.containerId === b.id && stopped.serverId === 'local' && stopped.state === 'exited');
    record('bound-observe-stopped');

    step = 'bound-observe-unknown';
    await requireObservationError(nativeObserver(randomBytes(32).toString('hex')).observe(authorized), 'response');
    record('bound-observe-unknown');

    step = 'bound-observe-timeout';
    await fixture.withPausedWhiskers(() => requireObservationError(observer.observe(authorized), 'timeout'));
    const recovered = await observer.observe(authorized);
    requireProof(recovered.containerId === a.id && recovered.state === 'running' && await fixture.healthy(fixture.primary));
    record('bound-observe-timeout');

    step = 'bound-log-signals';
    const logs = await nativeObserver(b.id).observeLogs(authorized);
    requireProof(logs.containerId === b.id && logs.serverId === 'local' && logs.lines === 2
      && logs.warningLines === 1 && logs.errorLines === 1 && Object.keys(logs).length === 7);
    record('bound-log-signals');

    step = 'bound-metrics-unavailable';
    const missingId = randomBytes(32).toString('hex');
    const unavailable = await nativeObserver(missingId).observeMetrics(authorized);
    requireProof(unavailable.containerId === missingId && unavailable.status === 'unavailable' && unavailable.reason === 'no_samples');
    record('bound-metrics-unavailable');

    step = 'bound-metrics-present';
    let metrics = await observer.observeMetrics(authorized);
    for (let attempt = 0; metrics.status === 'unavailable' && attempt < 4; attempt++) {
      await wait(7_500);
      metrics = await observer.observeMetrics(authorized);
    }
    requireProof(metrics.containerId === a.id && metrics.serverId === 'local' && metrics.status === 'observed'
      && metrics.dataPoints >= 1 && metrics.period === '1h' && await fixture.healthy(fixture.primary));
    record('bound-metrics-present');
  } catch (error) {
    if (step === 'approved-dispatch') {
      const actual = await fixture.snapshot(fixture.primary).catch(() => undefined);
      console.log('Whiskers recovery observation: ' + (actual ? 'fixture_observed' : 'unavailable'));
    }
    const location = error instanceof NativeBrowserFailure
      ? step + ' (' + error.reason + (error.outcome ? ', ' + error.outcome : '') + ')'
      : error instanceof WhiskersObservationError || error instanceof WhiskersRestartError ? step + ' (' + error.reason + ')' : step;
    checks.push({ id: 'native-verification', status: 'failed', detail: messages.stopped[language] + ' ' + location + '.' });
  } finally {
    await Promise.allSettled([...clients].map(client => client.close()));
    await browser?.close().catch(() => undefined);
    const clean = await fixture.close();
    if (clean) record('clean');
    else checks.push({ id: 'cleanup', status: 'failed', detail: messages.stopped[language] + ' fixture-cleanup.' });
  }
  return finish();
}

process.exitCode = await executeProbe('whiskers-native', run);
