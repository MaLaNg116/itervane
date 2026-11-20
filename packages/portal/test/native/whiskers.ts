import { chromium, type Browser } from '@playwright/test';
import { localeSchema, type Check } from '@itervane/contracts';
import { confirmationId, toolText, WhiskersProbeClient, whiskersOrigin, whiskersVersion } from '../../../verification/src/native/whiskers.js';
import { executeProbe, report } from '../../../verification/src/report.js';
import { eligibleHost, WhiskersFixture } from './whiskers-fixture.js';
import { approveRestart, createWriteKey, NativeBrowserFailure, observeRestartAudit, openPermissions, selectWriteLevel, signIn } from './whiskers-ui.js';

const messages = {
  host: ['Use an isolated GitHub-hosted Linux test machine.', '需要独立的 GitHub 托管 Linux 测试机。'],
  observe: ['The authenticated MCP observation matched the running fixture.', '已认证的 MCP 观察与实际样例一致。'],
  pending: ['The first restart request entered native approval and left the actual fixture unchanged.', '首次重启请求进入原生审批，样例运行状态未变化。'],
  approved: ['The browser approver confirmed the exact request. The fixture still awaited execution.', '浏览器身份确认了原请求，样例仍等待执行。'],
  binding: ['Changing either the caller or the target required a separate native approval.', '更换调用身份或目标均要求新的原生审批。'],
  applied: ['The identical request after reconnect restarted only the approved container, and its HTTP health responded.', '重连后同参请求只重启了已批准容器，其 HTTP 健康检查通过。'],
  consumed: ['A further call required a fresh approval. The previous grant was used once.', '再次调用需要新审批，之前的授权仅执行了一次。'],
  audit: ['The native audit view recorded a single restart for the expected actor and target.', '原生审计视图仅记录一次重启，调用身份与目标匹配。'],
  stopped: ['Verification stopped at', '验证中止于'],
  clean: ['Temporary containers and password file were removed.', '已清理临时容器和口令文件。'],
} as const;

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error('Missing native evidence');
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
    await signIn(page, fixture.adminPassword);

    step = 'native-key-settings';
    await openPermissions(page);
    step = 'native-key-level';
    await selectWriteLevel(page);
    step = 'primary-key';
    const primaryKey = 'itervane-probe-primary';
    const key = await createWriteKey(page, primaryKey);
    step = 'alternate-key';
    const alternateKey = await createWriteKey(page, 'itervane-probe-alternate');
    requireProof(key !== alternateKey);

    step = 'native-mcp-connect';
    const client = await connect(key);
    const alternateClient = await connect(alternateKey);
    step = 'mcp-observe';
    const observed = await client.observe(a.id);
    const observedText = toolText(observed);
    requireProof(!observed.isError && observedText?.includes('ID: ' + a.id) && observedText.includes('State: running'));
    record('observe', ' Whiskers ' + whiskersVersion + '.');

    step = 'pending-confirmation';
    const id = confirmationId(await client.restart(a.id));
    requireProof(id && await unchanged());
    const pendingId = confirmationId(await client.restart(a.id));
    requireProof(pendingId === id && await unchanged());
    record('pending', ' Approval=' + id + '.');

    step = 'browser-approval';
    await approveRestart(page, a.id);
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
    const resumed = await connect(key);
    step = 'approved-dispatch';
    // Exactly one dispatch after approval. An error leads to a read-only
    // observation of the actual fixture and exits without redispatch.
    const result = await resumed.restart(a.id);
    const restarted = await fixture.snapshot(fixture.primary);
    requireProof(!result.isError && toolText(result)?.includes(fixture.primary) && toolText(result)?.endsWith('restarted.')
      && restarted.id === a.id && Date.parse(restarted.started) > Date.parse(a.started)
      && await unchanged(restarted.started) && await fixture.healthy(fixture.primary));
    record('applied');

    step = 'used-approval';
    const replay = confirmationId(await resumed.restart(a.id));
    requireProof(replay && ![id, differentCaller, differentTarget].includes(replay) && await unchanged(restarted.started));
    record('consumed', ' Approval=' + replay + '.');

    step = 'native-restart-audit';
    await observeRestartAudit(page, fixture.primary, primaryKey);
    record('audit');
  } catch (error) {
    if (step === 'approved-dispatch') {
      const actual = await fixture.snapshot(fixture.primary).catch(() => undefined);
      console.log('Whiskers recovery observation: ' + (actual ? 'fixture_observed' : 'unavailable'));
    }
    const location = error instanceof NativeBrowserFailure
      ? step + ' (' + error.reason + (error.outcome ? ', ' + error.outcome : '') + ')'
      : step;
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
