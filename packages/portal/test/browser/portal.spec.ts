import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test as base, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { admissionDtoSchema, catalogDtoSchema, confirmOperationsRepairSchema, formalAuditDtoSchema, formalReleaseCandidateDtoSchema, formalReleaseDecisionResultSchema,
  formalReleaseViewSchema, formalRepairDtoSchema, formalRepairPatchDtoSchema, operationsObservationViewSchema, operationsProposalViewSchema,
  operationsEnqueueInputSchema, operationsRestartContinueInputSchema, operationsRestartEnqueueInputSchema, operationsRestartExecutionViewSchema,
  operationsIncidentStopResultSchema, operationsIncidentsViewSchema, operationsRepairViewSchema, operationsRestoreExecutionViewSchema,
  preauditDtoSchema, releaseDecisionInputSchema, sourceInspectionDtoSchema, stopOperationsIncidentDiagnosisSchema, taskDtoSchema,
  taskIncidentViewSchema, translate, verificationViewSchema,
  type FormalReleaseCandidateDto, type Locale, type OperationsRestartExecutionView, type TaskDto } from '@itervane/contracts';
import { browserStack } from './stack.js';
import { ui, type UiKey } from '../../src/messages.js';

type Stack = Awaited<ReturnType<typeof browserStack>>;
const test = base.extend<{}, { stack: Stack }>({ stack: [async ({}, use) => {
  const stack = await browserStack(); try { await use(stack); } finally { await stack.close(); }
}, { scope: 'worker', timeout: 180_000 }] });

test.afterEach(async ({ page, stack }, info) => {
  if (info.status === info.expectedStatus || page.isClosed()) return;
  const origin = new URL(page.url()).origin;
  info.annotations.push({ type: 'failure-surface', description: origin === stack.origin ? 'application' : origin === new URL(stack.issuer).origin ? 'identity' : 'other' });
  if (new URL(page.url()).origin === stack.origin) {
    await page.screenshot({ path: `.reports/p1-c/failed-${info.title.replace(/[^a-zA-Z0-9-]/g, '-')}.png`, fullPage: true });
    console.log(`Application view at failure: ${new URL(page.url()).pathname}`);
  }
});

async function language(page: Page, locale: 'en' | 'zh-CN') {
  await page.getByRole('combobox', { name: /^(Language|显示语言)$/ }).selectOption(locale);
}
function flowPhase(description: string) {
  const annotations = test.info().annotations; const current = annotations.find(value => value.type === 'flow-phase');
  if (current) current.description = description; else annotations.push({ type: 'flow-phase', description });
}
async function login(page: Page, stack: Stack, username = 'owner', locale: 'en' | 'zh-CN' = 'en') {
  flowPhase('portal');
  await page.goto(stack.origin); if (locale === 'zh-CN') await language(page, locale);
  flowPhase('login');
  await page.getByRole('button', { name: locale === 'en' ? 'Sign in' : '登录平台', exact: true }).click();
  await page.locator('#username').fill(username); await page.locator('#password').fill(stack.password); await page.locator('#kc-login').click();
  flowPhase('callback');
}

function authorizationFrom(page: Page) {
  let authorization = '';
  page.on('request', request => { if (new URL(request.url()).pathname === '/v1/me') authorization = request.headers().authorization ?? ''; });
  return () => authorization;
}
async function seedProject(stack: Stack, viewer = false) {
  const id = randomUUID(); const repositoryId = randomUUID(); const title = `Boundary ${id.slice(0, 8)}`;
  await stack.database.admin.query('INSERT INTO itervane.projects(id,workspace_id,name,slug) SELECT $1,id,$2,$3 FROM itervane.workspaces', [id, title, `boundary-${id}`]);
  await stack.database.admin.query('INSERT INTO itervane.repositories(id,project_id,name,url) VALUES($1,$2,$3,$4)', [repositoryId, id, 'Reference source', 'https://example.invalid/boundary.git']);
  if (viewer) await stack.database.admin.query("INSERT INTO itervane.project_members(project_id,principal_id,role) SELECT $1,id,'viewer' FROM itervane.principals WHERE issuer=$2 AND subject=$3", [id, stack.issuer, stack.viewerId]);
  return { id, repositoryId, title };
}
async function admit(stack: Stack, authorization: string, project: Awaited<ReturnType<typeof seedProject>>) {
  const response = await fetch(`${stack.origin}/v1/tasks`, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, source: { repositoryId: project.repositoryId, commit: 'b'.repeat(40) }, purpose: 'Browser boundary check', dataClass: 'synthetic', locale: 'en', idempotencyKey: randomUUID() }) });
  expect(response.status).toBe(202); return admissionDtoSchema.parse(await response.json()).task;
}
async function paused(stack: Stack, taskId: string) {
  await expect.poll(async () => (await stack.database.admin.query('SELECT state FROM itervane.tasks WHERE id=$1', [taskId])).rows[0]?.state).toBe('waiting_input');
}
async function openPreaudit(page: Page, stack: Stack, project: Awaited<ReturnType<typeof seedProject>>, locale: 'en' | 'zh-CN' = 'en', username = 'owner') {
  await login(page, stack, username, locale); await page.getByRole('link', { name: project.title, exact: true }).click();
  await page.getByRole('link', { name: locale === 'en' ? 'Rules and text preaudit' : '规则与文本预审', exact: true }).click();
  await expect(page.getByTestId('rule-bounded-review-context')).toBeVisible();
}

test('renders the audit checklist with locale-independent evidence and escaped notes', async ({ page, stack }) => {
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const finding = { id: hash('finding'), ruleId: 'fixture-pattern', path: 'settings/example.txt', line: 3,
    severity: 'unknown', certainty: 'suspected', scanner: 'gitleaks', impact: 'Review fixture <audit-fixture> verbatim.', suggestion: 'Ask the owner to verify the match.' };
  const evidenceIds = [hash('gitleaks'), hash('trivy')];
  const result = { version: 1, taskId: task.id, runId: task.runId, projectId: project.id, generation: 1, locale: 'en',
    inputSha256: hash('input'), checkpointId: randomUUID(), inspectionSha256: hash('inspection'), snapshotSha256: hash('snapshot'),
    catalogSha256: hash('catalog'), status: 'completed', reason: 'audit_complete', provider: 'anthropic', usage: { turns: 3, toolCalls: 2, tokens: 90 },
    evidence: [{ kind: 'scan', id: evidenceIds[0], scanner: 'gitleaks', version: '8.30.1', policySha256: hash('secret-policy'), databaseSha256: null,
      totalFindings: 1, findingIds: [finding.id] }, { kind: 'scan', id: evidenceIds[1], scanner: 'trivy', version: '0.70.0', policySha256: hash('dependency-policy'),
      databaseSha256: hash('vulnerability-db'), totalFindings: 0, findingIds: [] }],
    trace: evidenceIds.map(evidenceId => ({ operationId: hash(evidenceId), tool: 'read_scan', evidenceId })),
    checklist: { summary: 'Two protected scans reviewed.', coverage: 'complete', findings: [finding], hypotheses: [], evidenceIds, limits: ['Scope covers secret and dependency checks.'] },
  };
  // The Worker and persisted response are verified separately against PostgreSQL; this fixture drives the browser rendering branch.
  await page.route(`${stack.origin}/v1/tasks/${task.id}/audit`, async route => {
    const locale = route.request().headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
    await route.fulfill({ json: formalAuditDtoSchema.parse({ taskId: task.id, runId: task.runId, locale, status: 'recorded',
      sha256: hash('record'), recordedAt: task.createdAt, result, message: locale === 'zh-CN' ? '已形成审计清单。' : 'Audit checklist recorded.',
    }) });
  });
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  const panel = page.getByTestId('formal-audit');
  await expect(panel.getByText('Potential impact')).toBeVisible();
  await expect(panel.getByText(finding.impact, { exact: true })).toHaveAttribute('lang', 'en');
  await expect(panel.locator('audit-fixture')).toHaveCount(0);
  await expect(panel.getByText(`${finding.path}:${finding.line}`, { exact: true })).toBeVisible();
  await panel.getByText('Evidence references', { exact: true }).click();
  await expect(panel.getByText(evidenceIds[0]!, { exact: true })).toBeVisible();
  await language(page, 'zh-CN');
  await expect(panel.getByText('潜在影响')).toBeVisible();
  await expect(panel.getByText('已形成审计清单。')).toBeVisible();
  await expect(panel.getByText(finding.impact, { exact: true })).toHaveAttribute('lang', 'en');
});

test('resumes a recorded audit and downloads its versioned repair patch in the bilingual portal', async ({ page, stack }) => {
  await observeMotion(page, stack.origin);
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const created = await admit(stack, authorization(), project);
  await paused(stack, created.id);
  const base = `${stack.origin}/v1/tasks/${created.id}`;
  const task = taskDtoSchema.parse(await (await fetch(base, { headers: { Authorization: authorization() } })).json());
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  const patch = { version: 1, baseSnapshotSha256: hash('original'), files: [{
    path: 'settings/example.txt', beforeSha256: hash('before'), edits: [{ startByte: 2, endByte: 9, replacement: '' }],
  }] };
  const patchSha256 = hash(JSON.stringify(patch));
  const resultSha256 = hash('repair result');
  const summary = 'Removed a fixture entry <repair-fixture>.';
  const result = { version: 1, taskId: task.id, runId: task.runId, projectId: project.id, generation: 1, locale: 'en',
    inputSha256: hash('input'), checkpointId: randomUUID(), auditResultSha256: hash('audit'), baseSnapshotSha256: patch.baseSnapshotSha256,
    provider: 'anthropic', releaseEligible: false, usage: { turns: 3, toolCalls: 2, tokens: 90 }, status: 'candidate_ready', reason: 'repair_complete',
    candidate: { summary, evidenceId: hash('evidence'), operationId: randomUUID(), receiptSha256: hash('receipt'),
      patchSha256, manifestSha256: hash('candidate'), changes: [{ path: patch.files[0]!.path, beforeSha256: hash('before'),
        afterSha256: hash('after'), beforeBytes: 17, afterBytes: 10, edits: 1,
      }],
    },
  };
  let published = false;
  await page.route(`${base}/repair`, async route => {
    const locale = route.request().headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
    const coordinates = { taskId: task.id, runId: task.runId, locale };
    const response = published
      ? { ...coordinates, status: 'recorded', sha256: resultSha256, recordedAt: task.createdAt, result, resumeAvailable: false,
        message: locale === 'en' ? 'Candidate ready for independent verification.' : '候选已就绪，等待独立复验。',
      }
      : { ...coordinates, status: 'pending', result: null, resumeAvailable: true, message: 'Audit ready for repair.' };
    await route.fulfill({ json: formalRepairDtoSchema.parse(response) });
  });
  await page.route(`${base}/resume`, async route => {
    expect(route.request().postDataJSON()).toEqual({ expectedVersion: task.version });
    published = true;
    await route.fulfill({ json: taskDtoSchema.parse({ ...task, version: task.version + 1, state: 'queued' }) });
  });
  await page.route(`${base}/repair/patch?expectedSha256=${resultSha256}`, route =>
    route.fulfill({ json: formalRepairPatchDtoSchema.parse({ taskId: task.id, runId: task.runId, resultSha256, patchSha256, patch }) }));
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  const panel = page.getByTestId('formal-repair');
  await panel.getByRole('button', { name: 'Continue to repair', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Continue from the recorded audit?' });
  await dialog.getByRole('button', { name: 'Continue to repair', exact: true }).click();
  await expect(panel.getByRole('table', { name: 'Candidate changes' })).toContainText('settings/example.txt');
  await expect(panel.getByText(summary, { exact: true })).toHaveAttribute('lang', 'en');
  await expect(panel.locator('repair-fixture')).toHaveCount(0);
  await language(page, 'zh-CN');
  await expect(panel.getByRole('table', { name: '候选变更' })).toContainText('修改前（字节）');
  await expect(panel.getByText('候选已就绪，等待独立复验。')).toBeVisible();
  await expect(panel.getByText(summary, { exact: true })).toHaveAttribute('lang', 'en');
  const pending = page.waitForEvent('download');
  await panel.getByRole('button', { name: '下载补丁' }).click();
  const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe(`itervane-patch-${patchSha256.slice(0, 12)}.json`);
  expect(await readFile((await downloaded.path())!, 'utf8')).toBe(JSON.stringify(patch));
  expect((await motionProbe(page)).csp).toEqual([]);
});

test('shows independent verification across run revisions with bilingual keyboard access to retry evidence', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await observeMotion(page, stack.origin);
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project);
  const base = `${stack.origin}/v1/tasks/${task.id}`;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const nextRunId = randomUUID();
  const imageDigest = `sha256:${hash('second generation image')}`;
  const first = {
    runId: task.runId, generation: 1, status: 'recorded', outcome: 'checks_failed', recordedAt: task.createdAt,
    resultSha256: hash('first result'), receiptSha256: hash('first receipt'), candidateManifestSha256: hash('first candidate'),
    source: { status: 'compared', introduced: 0, resolved: 1, remaining: 0 }, build: { status: 'built', distSha256: hash('built') },
    baseline: { status: 'failed', baselineSha256: hash('baseline'), runtimeInputsSha256: hash('runtime inputs'),
      failures: [{ id: 'health', code: 'unexpected_status', statusCode: 503 }] }, image: { status: 'not_reached' },
  };
  let phase: 'pending' | 'recorded' | 'failure' = 'pending';
  let revision = task.version + 4;
  await page.route(base, route => route.fulfill({ json: taskDtoSchema.parse({ ...task, runId: nextRunId, version: revision,
    state: phase === 'pending' ? 'queued' : 'waiting_input',
  }) }));
  await page.route(`${base}/verification`, route => {
    const locale = route.request().headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
    if (phase === 'failure') return route.fulfill({ status: 503, json: { error: { code: 'unavailable', requestId: randomUUID(),
      messageKey: 'error.unavailable', message: translate(locale, 'error.unavailable'), locale,
    } } });
    const current = phase === 'pending'
      ? { runId: nextRunId, generation: 2, status: 'pending', message: translate(locale, 'verification.pending') }
      : { ...first, runId: nextRunId, generation: 2, outcome: 'observed', message: translate(locale, 'reason.verification_observed'),
        resultSha256: hash('second result'), receiptSha256: hash('second receipt'), candidateManifestSha256: hash('second candidate'),
        baseline: { ...first.baseline, status: 'passed', failures: [] },
        image: { status: 'scanned', manifestDigest: imageDigest, findings: { critical: 0, high: 0, medium: 1, low: 0, unknown: 0 } },
      };
    return route.fulfill({ json: verificationViewSchema.parse({ version: 1, taskId: task.id, locale, current,
      previous: { ...first, message: translate(locale, 'reason.verification_checks_failed') },
    }) });
  });
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  const panel = page.getByTestId('formal-verification');
  await expect(panel.getByRole('status')).toContainText('The current run has no independent verification result yet.');
  const previous = panel.getByText('Previous candidate', { exact: true });
  await previous.focus(); await previous.press('Enter');
  await expect(panel.getByText('Health · Unexpected HTTP status (503)', { exact: true })).toBeVisible();
  await expect.poll(async () => (await motionProbe(page)).disclosures).toBeGreaterThan(0);

  phase = 'recorded'; revision++;
  await expect(panel.getByRole('status')).toContainText('Run generation 2');
  await expect(panel.getByText(imageDigest, { exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await language(page, 'zh-CN');
  await expect(panel.getByRole('heading', { name: '独立复验' })).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('证据已记录');
  const reduced = await motionProbe(page);
  const history = panel.getByText('上一代候选', { exact: true });
  await history.focus(); await history.press('Enter');
  await expect(panel.getByText('健康检查 · HTTP 状态与预期不符 (503)', { exact: true })).toBeVisible();
  expect((await motionProbe(page)).disclosures).toBe(reduced.disclosures);

  phase = 'failure'; revision++;
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByText(imageDigest, { exact: true })).toHaveCount(0);
  await expect(history).toHaveCount(0);
  phase = 'recorded';
  await panel.getByRole('button', { name: '重新尝试' }).click();
  await expect(panel.getByText(imageDigest, { exact: true })).toBeVisible();
  await expectMotionCsp(page);
});

function frozenReleaseFixture(task: TaskDto) {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const ids = { applicationId: randomUUID(), environmentId: randomUUID() };
  const target = { ...ids, applicationName: 'Release portal sample', environmentName: 'Protected test' };
  const candidate = formalReleaseCandidateDtoSchema.parse({
    id: randomUUID(), fingerprint: hash('frozen candidate'), createdAt: task.createdAt, status: 'pending', decisionVersion: 0,
    decisions: [], operationId: null, locale: 'en', message: translate('en', 'task.release_candidate_frozen'),
    manifest: {
      version: 1, origin: 'formal_verification', releaseEligible: false, evidenceVersion: 1,
      taskId: task.id, runId: task.runId, generation: 1, projectId: task.projectId, source: task.source,
      originalSnapshotSha256: hash('source'), repairedSnapshotSha256: hash('patched source'), diffSha256: hash('patch'),
      verification: { inputSha256: hash('input'), resultSha256: hash('result'), receiptSha256: hash('receipt'), catalogSha256: hash('catalog'),
        profileSha256: hash('profile'), buildSha256: hash('build'), baselineSha256: hash('baseline'), source: { introduced: 0, resolved: 1, remaining: 0 } },
      image: { manifestDigest: `sha256:${hash('image')}`, configDigest: `sha256:${hash('image config')}`,
        archive: { format: 'oci-layout-tar', sha256: hash('archive'), bytes: 50_024 }, runnerImageSha256: hash('runner'),
        scanReportSha256: hash('scan'), scanPolicySha256: hash('policy'), findings: { critical: 0, high: 0, medium: 1, low: 0, unknown: 0 } },
      runtimeConfigSha256: hash('runtime config'), rolloutCheckSha256: hash('rollout'), recoveryPlanSha256: hash('recovery'),
      target: { ...ids, mappingSha256: hash('target mapping'), revision: 1 }, validUntil: new Date(Date.now() + 300_000).toISOString(),
    },
  });
  return { target, candidate };
}

test('uses the exact frozen release for bilingual decisions, closes stale approval, and reuses the request key on retry', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await observeMotion(page, stack.origin);
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project);
  const base = `${stack.origin}/v1/tasks/${task.id}`;
  const { target, candidate } = frozenReleaseFixture(task);
  let current: FormalReleaseCandidateDto | null = null;
  let taskVersion = task.version + 3;
  let state: TaskDto['state'] = 'waiting_input';
  let displaced = false;
  const requests: Array<ReturnType<typeof releaseDecisionInputSchema.parse>> = [];
  function localize(candidate: FormalReleaseCandidateDto, locale: 'en' | 'zh-CN') {
    const messages = { pending: 'task.release_candidate_frozen', confirmed: 'task.release_confirmed', revoked: 'task.release_revoked' } as const;
    if (candidate.status !== 'pending' && candidate.status !== 'confirmed' && candidate.status !== 'revoked') throw new Error('Unexpected fixture state');
    return { ...candidate, locale, message: translate(locale, messages[candidate.status]) };
  }
  // The authenticated UI/transport is real. Runner and decision ledger evidence are covered in the control-plane suites.
  await page.route(base, route => route.fulfill({ json: taskDtoSchema.parse({ ...task, state, version: taskVersion }) }));
  await page.route(`${base}/release`, route => {
    const locale = route.request().headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
    return route.fulfill({ json: formalReleaseViewSchema.parse({
      taskId: task.id, runId: displaced ? randomUUID() : task.runId, taskVersion,
      candidate: current ? localize(current, locale) : null, candidateTarget: current ? target : null, result: null,
      availableTargets: current ? [] : [{ ...target, revision: 1 }],
      actions: current?.status === 'pending' ? ['confirm', 'reject'] : current?.status === 'confirmed' ? ['revoke'] : [],
    }) });
  });
  await page.route(`${base}/release-candidate`, async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({ environmentId: target.environmentId, expectedVersion: taskVersion });
    current = candidate;
    taskVersion++;
    state = 'waiting_approval';
    await route.fulfill({ status: 201, json: candidate });
  });
  await page.route(`${stack.origin}/v1/release-candidates/${candidate.id}/decisions`, async route => {
    const body = releaseDecisionInputSchema.parse(route.request().postDataJSON());
    requests.push(body);
    expect(body.fingerprint).toBe(candidate.fingerprint);
    if (requests.length === 1) { await route.abort('failed'); return; }
    const expected = requests.length === 2 ? 'confirm' : 'revoke';
    expect(body.action).toBe(expected);
    const version = expected === 'confirm' ? 1 : 2;
    expect(body.expectedVersion).toBe(version - 1);
    current = { ...current!, status: expected === 'confirm' ? 'confirmed' : 'revoked', operationId: current?.operationId ?? randomUUID(),
      decisionVersion: version, decisions: [...(current?.decisions ?? []), {
        version, action: expected, actorId: task.requestedBy, decidedAt: task.createdAt, selfConfirmed: expected === 'confirm',
      }] };
    taskVersion++;
    state = expected === 'confirm' ? 'queued' : 'needs_human';
    await route.fulfill({ json: formalReleaseDecisionResultSchema.parse({ candidate: localize(current, 'zh-CN'), replayed: false }) });
  });

  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  const panel = page.getByTestId('formal-release');
  await expect(panel.getByRole('combobox', { name: 'Release target' })).toHaveValue(target.environmentId);
  await panel.getByRole('button', { name: 'Freeze candidate' }).click();
  await expect(panel.getByText(candidate.manifest.image.manifestDigest, { exact: true })).toBeVisible();
  const evidence = panel.getByText('Candidate evidence', { exact: true });
  await evidence.focus(); await evidence.press('Enter');
  await expect(panel.getByText(candidate.fingerprint, { exact: true })).toBeVisible();
  await expect.poll(async () => (await motionProbe(page)).disclosures).toBeGreaterThan(0);

  const approve = panel.getByRole('button', { name: 'Approve release', exact: true });
  await approve.focus(); await approve.press('Enter');
  const englishDialog = page.getByRole('dialog', { name: 'Approve this release candidate?' });
  await expect(englishDialog.getByRole('button', { name: 'Go back' })).toBeFocused();
  await expect(englishDialog.getByText(candidate.fingerprint, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(englishDialog).toHaveCount(0);
  await approve.click();
  await expect(englishDialog).toBeVisible();
  displaced = true;
  await expect(englishDialog).toHaveCount(0);
  await expect(panel.getByText(candidate.manifest.image.manifestDigest, { exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(0);

  displaced = false;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motionBefore = (await motionProbe(page)).disclosures;
  await language(page, 'zh-CN');
  const chineseEvidence = panel.getByText('候选证据', { exact: true });
  await chineseEvidence.focus(); await chineseEvidence.press('Enter');
  await expect(panel.getByText(candidate.fingerprint, { exact: true })).toBeVisible();
  expect((await motionProbe(page)).disclosures).toBe(motionBefore);

  await panel.getByRole('button', { name: '批准发布', exact: true }).click();
  const chineseDialog = page.getByRole('dialog', { name: '批准此发布候选？' });
  const confirm = chineseDialog.getByRole('button', { name: '批准发布', exact: true });
  await confirm.click();
  await expect(chineseDialog.getByRole('alert')).toBeVisible();
  await confirm.click();
  await expect(panel.getByRole('status')).toHaveText(/已入队/);
  await expect(panel.getByText('申请人本人确认', { exact: true })).toBeVisible();
  expect(requests[0]).toEqual(requests[1]);
  await panel.getByRole('button', { name: '撤销批准', exact: true }).click();
  await page.getByRole('dialog', { name: '撤销对此候选的批准？' }).getByRole('button', { name: '撤销批准', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText(/撤销/);
  await expect(panel.getByText('已撤销批准', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(3);
  await expectMotionCsp(page);
});

test('shows the bilingual release result as it changes and clears evidence from a previous run', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await observeMotion(page, stack.origin);
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project);
  const { candidate, target } = frozenReleaseFixture(task);
  const base = `${stack.origin}/v1/tasks/${task.id}`;
  const firstOperation = randomUUID();
  const firstUpdate = 'c'.repeat(24);
  const secondOperation = randomUUID();
  const checkedAt = new Date().toISOString();
  let taskRunId = task.runId;
  let taskVersion = task.version + 3;
  let taskState: TaskDto['state'] = 'reconciling';
  let releaseRunId = taskRunId;
  let releaseVersion = taskVersion;
  let status: 'checking' | 'verified' | 'manual_review' = 'checking';
  await page.route(base, route => route.fulfill({ json: taskDtoSchema.parse({
    ...task, runId: taskRunId, version: taskVersion, state: taskState,
  }) }));
  await page.route(`${base}/release`, route => {
    const locale = route.request().headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
    const operationId = status === 'manual_review' ? secondOperation : firstOperation;
    const updateId = status === 'manual_review' ? 'd'.repeat(24) : firstUpdate;
    const message = { checking: 'task.release_rollout_claimed', verified: 'release.operation.verified_formal',
      manual_review: 'release.result.manual_review' } as const;
    return route.fulfill({ json: formalReleaseViewSchema.parse({
      taskId: task.id, runId: releaseRunId, taskVersion: releaseVersion,
      candidate: { ...candidate, operationId, manifest: { ...candidate.manifest, runId: releaseRunId } },
      candidateTarget: target, availableTargets: [], actions: [],
      result: { operationId, candidateId: candidate.id, updateId, status, locale, message: translate(locale, message[status]),
        ...(status === 'verified' ? { evidence: { checkedAt, manifestDigest: candidate.manifest.image.manifestDigest,
          configDigest: candidate.manifest.image.configDigest, version: 'standard-v2', healthy: true, accessProtected: true } } : {}),
        ...(status === 'manual_review' ? { reason: 'release_rollout_health_failed',
          reasonMessage: translate(locale, 'reason.release_rollout_health_failed') } : {}),
      },
    }) });
  });
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  const result = page.getByTestId('release-result');
  await expect(result.getByRole('status')).toHaveText(translate('en', 'task.release_rollout_claimed'));
  await expect(result.getByText(firstUpdate, { exact: true })).toBeVisible();
  await expect(result.getByText('Running image digest')).toHaveCount(0);
  const disclosure = page.getByText('Candidate evidence', { exact: true });
  await disclosure.focus(); await disclosure.press('Enter');
  await expect(page.getByText(firstOperation, { exact: true })).toBeVisible();
  await expect.poll(async () => (await motionProbe(page)).disclosures).toBeGreaterThan(0);
  await disclosure.press('Enter');

  status = 'verified'; taskState = 'succeeded'; releaseVersion = ++taskVersion;
  await expect(result.getByRole('status')).toHaveText(translate('en', 'release.operation.verified_formal'));
  await expect(result.getByText(candidate.manifest.image.manifestDigest, { exact: true })).toBeVisible();
  await expect(result.getByText('standard-v2', { exact: true })).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const motionBefore = (await motionProbe(page)).disclosures;
  await language(page, 'zh-CN');
  await expect(result.getByRole('status')).toHaveText(translate('zh-CN', 'release.operation.verified_formal'));
  await expect(result.getByText('实际运行镜像摘要')).toBeVisible();
  const translatedDisclosure = page.getByText('候选证据', { exact: true });
  await translatedDisclosure.focus(); await translatedDisclosure.press('Enter');
  await expect(page.getByText(firstOperation, { exact: true })).toBeVisible();
  expect((await motionProbe(page)).disclosures).toBe(motionBefore);

  taskRunId = randomUUID(); taskVersion++; taskState = 'needs_human';
  await expect(result).toHaveCount(0);
  releaseRunId = taskRunId; releaseVersion = taskVersion; status = 'manual_review';
  await expect(result.getByRole('status')).toContainText(translate('zh-CN', 'release.result.manual_review'));
  await expect(result.getByRole('status')).toContainText(translate('zh-CN', 'reason.release_rollout_health_failed'));
  await expect(result.getByText('standard-v2', { exact: true })).toHaveCount(0);
  await expectMotionCsp(page);
});

test('shows release evidence without actions to a read-only member and clears it when access is revoked', async ({ page, stack }) => {
  const project = await seedProject(stack, true);
  const authorization = authorizationFrom(page);
  await stack.database.admin.query("UPDATE itervane.project_members SET role='maintainer' WHERE project_id=$1", [project.id]);
  await login(page, stack, 'viewer');
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const admitted = await admit(stack, authorization(), project);
  await paused(stack, admitted.id);
  await stack.database.admin.query("UPDATE itervane.project_members SET role='viewer' WHERE project_id=$1", [project.id]);
  const base = `${stack.origin}/v1/tasks/${admitted.id}`;
  const response = await fetch(base, { headers: { Authorization: authorization() } });
  const task = taskDtoSchema.parse(await response.json());
  const { candidate, target } = frozenReleaseFixture(task);
  await page.route(`${base}/release`, route => route.fulfill({ json: formalReleaseViewSchema.parse({
    taskId: task.id, runId: task.runId, taskVersion: task.version, candidate, candidateTarget: target, availableTargets: [], actions: [], result: null,
  }) }));
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  const panel = page.getByTestId('formal-release');
  await expect(panel.getByText(candidate.manifest.image.manifestDigest, { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Freeze candidate|Approve release|Reject candidate|Withdraw approval/ })).toHaveCount(0);
  await page.unroute(`${base}/release`);
  await stack.database.admin.query('DELETE FROM itervane.project_members WHERE project_id=$1', [project.id]);
  await expect(panel).toHaveCount(0);
  await expect(page.getByText(candidate.manifest.image.manifestDigest, { exact: true })).toHaveCount(0);
});

type MotionProbe = { state: number; events: number; headings: number; disclosures: number; csp: string[]; privateWithError: boolean };
async function observeMotion(page: Page, origin: string) {
  await page.addInitScript(origin => {
    if (location.origin !== origin) return;
    const probe = { state: 0, events: 0, headings: 0, disclosures: 0, csp: [] as string[], privateWithError: false };
    (window as unknown as { itervaneMotionProbe: typeof probe }).itervaneMotionProbe = probe;
    document.addEventListener('securitypolicyviolation', event => { probe.csp.push(event.effectiveDirective); });
    new MutationObserver(records => {
      for (const record of records) {
        const element = record.target;
        if (record.type !== 'attributes' || !(element instanceof HTMLElement) || !element.style.transform) continue;
        if (element.matches('.state-marker')) probe.state++;
        if (element.matches('.event-index')) probe.events++;
        if (element.matches('.heading-accent')) probe.headings++;
        if (element.matches('.disclosure-content')) probe.disclosures++;
      }
      if (document.querySelector('main [data-slot="alert"][role="alert"]') && document.querySelector('[data-testid="rule-bounded-review-context"]')) probe.privateWithError = true;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  }, origin);
}
const motionProbe = (page: Page) => page.evaluate(() => (window as unknown as { itervaneMotionProbe: MotionProbe }).itervaneMotionProbe);
async function captureWorkspace(page: Page, path: string) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path, fullPage: true });
}
async function expectMotionCsp(page: Page) {
  expect((await motionProbe(page)).csp).toEqual([]);
}

test('diagnoses the visible release with bilingual evidence, scoped retry and live project permissions', async ({ browser, page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await observeMotion(page, stack.origin);
  const project = await seedProject(stack, true);
  const other = await seedProject(stack, true);
  const authorization = authorizationFrom(page);
  await stack.database.admin.query("UPDATE itervane.project_members SET role='maintainer' WHERE project_id=$1", [project.id]);
  await login(page, stack, 'viewer');
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const source = await admit(stack, authorization(), project);
  const diagnostic = await admit(stack, authorization(), project);
  await Promise.all([paused(stack, source.id), paused(stack, diagnostic.id)]);
  const deliveryPath = `${stack.origin}/v1/tasks/${source.id}`;
  const diagnosticPath = `${stack.origin}/v1/tasks/${diagnostic.id}`;
  const readTask = async (url: string) => taskDtoSchema.parse(await (await fetch(url, { headers: { Authorization: authorization() } })).json());
  const delivery = await readTask(deliveryPath);
  const persisted = await readTask(diagnosticPath);
  const queued = taskDtoSchema.parse({ ...persisted, workflow: 'operations', state: 'queued', purpose: 'Diagnose the published application' });
  const { candidate, target } = frozenReleaseFixture(delivery);
  const releaseOperationId = randomUUID();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const receiptSha256 = hash('recorded container state');
  const diagnosisDigest = hash('recorded operations diagnosis');
  const containerEvidenceId = hash('diagnostic container fact');
  const releaseEvidenceId = hash('diagnostic release fact');
  const logsEvidenceId = hash('diagnostic log fact');
  const metricsEvidenceId = hash('diagnostic metrics fact');
  const logDigest = hash('normalized log evidence');
  const observedAt = new Date().toISOString();
  let observed = false;
  let availableOperation = randomUUID();
  const activeTask = () => observed ? { ...queued, version: queued.version + 1, state: 'succeeded' } : queued;
  const replyLocale = (headers: Record<string, string>) => headers['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
  // Preserve current task authorization while substituting the already-verified downstream evidence.
  await page.route(deliveryPath, async route => {
    const response = await route.fetch();
    return response.ok() ? route.fulfill({ json: { ...delivery, state: 'succeeded' } }) : route.fulfill({ response });
  });
  await page.route(`${deliveryPath}/release`, route => {
    const locale = replyLocale(route.request().headers());
    return route.fulfill({ json: formalReleaseViewSchema.parse({
      taskId: delivery.id, taskVersion: delivery.version, runId: delivery.runId,
      candidate: { ...candidate, status: 'confirmed', operationId: releaseOperationId }, candidateTarget: target,
      availableTargets: [], actions: [], result: {
        operationId: releaseOperationId, candidateId: candidate.id, updateId: 'c'.repeat(24), status: 'verified', locale,
        message: translate(locale, 'release.operation.verified_formal'), evidence: {
          checkedAt: observedAt, manifestDigest: candidate.manifest.image.manifestDigest, configDigest: candidate.manifest.image.configDigest,
          version: 'standard-v2', healthy: true, accessProtected: true,
        },
      },
    }) });
  });
  await page.route(`${deliveryPath}/operations-option`, route => route.fulfill({ json: {
    option: { projectId: project.id, environmentId: target.environmentId, releaseOperationId: availableOperation, diagnosis: true },
  } }));
  const diagnosticView = (locale: Locale) => {
    const current = activeTask();
    return operationsObservationViewSchema.parse({
      version: 1, taskId: current.id, runId: current.runId, taskVersion: current.version, state: current.state,
      applicationId: target.applicationId, environmentId: target.environmentId, releaseOperationId,
      observation: observed ? { state: 'exited', stateLabel: translate(locale, 'operations.container.exited'), observedAt, receiptSha256 } : null,
      ...(observed ? { diagnosis: {
        receiptSha256: diagnosisDigest, previousReleaseOperationId: null,
        hypotheses: [{ code: 'application_error', evidenceIds: [logsEvidenceId],
          message: locale === 'zh-CN' ? '采样日志包含应用错误。' : 'The sampled logs contain application errors.' }],
        recommendation: { code: 'review_restart', evidenceIds: [containerEvidenceId, releaseEvidenceId],
          message: locale === 'zh-CN' ? '评估是否重启已发布容器。' : 'Review restarting the published container.' },
        facts: [
          { section: 'container', evidenceId: containerEvidenceId, proofSha256: hash('normalized state'), result: { state: 'exited', observedAt } },
          { section: 'release', evidenceId: releaseEvidenceId, proofSha256: hash('verified release history'),
            result: { current: { operationId: releaseOperationId, manifestDigest: candidate.manifest.image.manifestDigest, verifiedAt: observedAt }, previous: null,
              runbooks: { version: 1, snapshotSha256: hash('selected Runbook snapshot'), byState: {
                exited: { status: 'available', version: '1.2.0', validationSha256: hash('Runbook validation'), action: 'restart_current_publication',
                  rule: { kind: 'runbook', packageId: 'fa827635-4c43-46d3-b29a-38a74a35b18b', packageKey: 'restart-verified-stopped-app',
                    versionId: '285240ff-4d48-4b98-916f-bee24224c4c9', versionSha256: hash('submitted Runbook'),
                    reviewSha256: hash('human-reviewed Runbook'), sequence: 3 },
                  controls: { publicationBinding: 'exact', approval: 'portal_and_whiskers', maxNativeAttempts: 1,
                    stopOn: ['target_drift', 'unknown_outcome', 'failed_health'] },
                  success: { instance: 'same', newerStart: true, healthStatus: 200, access: 'protected' } },
                dead: { status: 'no_match' },
              } },
            } },
          { section: 'logs', evidenceId: logsEvidenceId, proofSha256: logDigest,
            result: { observedAt, tailLines: 40, lines: 8, warningLines: 1, errorLines: 2 } },
          { section: 'metrics', evidenceId: metricsEvidenceId, proofSha256: hash('collected metrics'),
            result: { observedAt, period: '1h', status: 'observed', dataPoints: 3,
              cpu: { minimum: 1, average: 10, maximum: 25 }, memory: { minimum: 45, average: 92, maximum: 98 } } },
        ],
      } } : {}),
      locale, message: translate(locale, observed ? 'task.operations_observed' : 'state.queued'), reason: observed ? 'operations_diagnosed' : null,
      reasonMessage: observed ? translate(locale, 'reason.operations_diagnosed') : null,
    });
  };
  const proposalId = randomUUID();
  const fingerprint = hash('operations action proposal');
  const decisionUrl = `${stack.origin}/v1/operations/proposals/${proposalId}/decisions`;
  const proposalSubmissions: unknown[] = [];
  const decisionSubmissions: unknown[] = [];
  const ownerActorId = randomUUID();
  let maintainerCanWrite = true;
  let prepared = false;
  let decidedAt: string | undefined;
  const proposalView = (locale: Locale, owner: boolean) => operationsProposalViewSchema.parse({
    taskId: diagnostic.id, runId: persisted.runId, taskVersion: activeTask().version, locale,
    draft: observed && !prepared && (owner || maintainerCanWrite) ? { diagnosisSha256: diagnosisDigest, kind: 'restart' } : null,
    proposal: prepared ? {
      id: proposalId, fingerprint, kind: 'restart', status: decidedAt ? 'confirmed' : 'pending',
      message: translate(locale, decidedAt ? 'operations.proposal_confirmed' : 'operations.proposal_pending'),
      validUntil: new Date(Date.parse(observedAt) + 120_000).toISOString(),
      current: { operationId: releaseOperationId, manifestDigest: candidate.manifest.image.manifestDigest },
      restore: null, actions: owner ? decidedAt ? ['revoke'] : ['confirm', 'reject'] : [],
      decisions: decidedAt ? [{ version: 1, action: 'confirm', actorId: ownerActorId, selfConfirmed: false, decidedAt }] : [],
    } : null,
  });
  const setDiagnosticRoutes = async (sessionPage: Page, owner: boolean) => {
    await sessionPage.route(diagnosticPath, async route => {
      const response = await route.fetch();
      return response.ok() ? route.fulfill({ json: activeTask() }) : route.fulfill({ response });
    });
    await sessionPage.route(`${diagnosticPath}/operations`, route =>
      route.fulfill({ json: diagnosticView(replyLocale(route.request().headers())) }));
    await sessionPage.route(`${diagnosticPath}/operations-proposal`, route => {
      const request = route.request();
      if (request.method() === 'POST') {
        if (!owner && !maintainerCanWrite) return route.fulfill({ status: 403 });
        proposalSubmissions.push(request.postDataJSON());
        prepared = true;
      }
      return route.fulfill({ json: proposalView(replyLocale(request.headers()), owner) });
    });
  };
  await setDiagnosticRoutes(page, false);
  const submissions: unknown[] = [];
  const late = Promise.withResolvers<void>();
  const startUrl = `${stack.origin}/v1/operations/diagnoses`;
  await page.route(startUrl, async route => {
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) return route.abort('failed');
    if (submissions.length === 2) return route.fulfill({ status: 200, json: { task: queued, replayed: true } });
    if (submissions.length === 3) await late.promise;
    return route.fulfill({ status: 202, json: { task: queued, replayed: false } });
  });

  const sourcePage = `${stack.origin}/#/tasks/${delivery.id}`;
  await page.goto(sourcePage);
  await expect(page.getByTestId('release-result')).toBeVisible();
  const launch = page.getByRole('button', { name: 'Diagnose published application', exact: true });
  await expect(launch).toHaveCount(0);
  availableOperation = releaseOperationId;
  await launch.click();
  await expect(page.getByText('The request could not be completed. Check the connection and try again.')).toBeVisible();
  await language(page, 'zh-CN');
  await page.getByRole('button', { name: '重试同一请求', exact: true }).click();
  const panel = page.getByTestId('operations-observation');
  await expect(panel.getByRole('status')).toHaveText(translate('zh-CN', 'state.queued'));
  expect(submissions).toHaveLength(2);
  expect(submissions[0]).toMatchObject({ projectId: project.id, environmentId: target.environmentId, expectedReleaseOperationId: releaseOperationId,
    idempotencyKey: expect.any(String), locale: 'en' });
  expect(submissions[1]).toEqual(submissions[0]);
  await expect(page.getByTestId('source-inspection')).toHaveCount(0);
  await expect(page.getByTestId('formal-release')).toHaveCount(0);
  const inProgressMotion = await motionProbe(page);
  observed = true;
  await expect(panel.getByText('已退出', { exact: true })).toBeVisible();
  await expect.poll(async () => (await motionProbe(page)).state).toBeGreaterThan(inProgressMotion.state);
  await expect(panel.locator('time')).toHaveAttribute('datetime', observedAt);
  const diagnosis = panel.getByTestId('operations-diagnosis');
  await expect(panel.getByRole('heading', { name: '运维诊断' })).toBeVisible();
  await expect(diagnosis.getByText('评估是否重启已发布容器。', { exact: true })).toBeVisible();
  await expect(diagnosis.getByRole('list', { name: '引用证据' }).first().getByRole('listitem')).toHaveText(['容器状态', '已核验发布']);
  await expect(diagnosis.getByText(logDigest, { exact: true })).toBeHidden();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const beforeDisclosure = await motionProbe(page);
  await diagnosis.locator('summary').filter({ hasText: '诊断证据' }).press('Enter');
  await expect(panel.getByText(receiptSha256, { exact: true })).toBeVisible();
  await expect(diagnosis.getByText(diagnosisDigest, { exact: true })).toBeVisible();
  await expect(diagnosis.getByText(logDigest, { exact: true })).toBeVisible();
  await expect(diagnosis.getByText('92%', { exact: true })).toBeVisible();
  await expect(diagnosis.getByText('固定的 Runbook', { exact: true })).toBeVisible();
  await expect(diagnosis.getByText('restart-verified-stopped-app · 1.2.0', { exact: true })).toBeVisible();
  expect((await motionProbe(page)).disclosures).toBe(beforeDisclosure.disclosures);
  await language(page, 'en');
  await expect(panel.getByText('Exited', { exact: true })).toBeVisible();
  await expect(diagnosis.getByText('Review restarting the published container.', { exact: true })).toBeVisible();
  const englishRunbook = diagnosis.getByText('Pinned Runbook', { exact: true });
  if (!(await englishRunbook.isVisible())) await diagnosis.locator('summary').filter({ hasText: 'Diagnosis evidence' }).press('Enter');
  await expect(englishRunbook).toBeVisible();

  const proposal = panel.getByTestId('operations-proposal');
  await proposal.getByRole('button', { name: 'Prepare restart proposal', exact: true }).click();
  await expect(proposal.getByRole('status')).toHaveText(translate('en', 'operations.proposal_pending'));
  await expect(proposal.getByRole('button', { name: 'Approve action', exact: true })).toHaveCount(0);
  expect(proposalSubmissions).toEqual([{ diagnosisSha256: diagnosisDigest }]);
  const diagnosticPage = `${stack.origin}/#/tasks/${diagnostic.id}`;
  const ownerPage = await browser.newPage({ reducedMotion: 'reduce' });
  try {
    await setDiagnosticRoutes(ownerPage, true);
    await ownerPage.route(decisionUrl, route => {
      const input = releaseDecisionInputSchema.parse(route.request().postDataJSON());
      decisionSubmissions.push(input);
      if (decisionSubmissions.length === 1) return route.abort('failed');
      decidedAt = new Date().toISOString();
      return route.fulfill({ json: proposalView(replyLocale(route.request().headers()), true) });
    });
    await login(ownerPage, stack, 'owner', 'zh-CN');
    await expect(ownerPage.getByRole('link', { name: project.title, exact: true })).toBeVisible();
    await ownerPage.goto(diagnosticPage);
    const ownerProposal = ownerPage.getByTestId('operations-proposal');
    await ownerProposal.getByRole('button', { name: '批准处置', exact: true }).click();
    const decision = ownerPage.getByRole('dialog', { name: '核对此处置决定' });
    await expect(decision.getByText(candidate.manifest.image.manifestDigest, { exact: true })).toBeVisible();
    const confirm = decision.getByRole('button', { name: '批准处置', exact: true });
    await confirm.click();
    await expect(decision.getByRole('alert')).toBeVisible();
    await confirm.click();
    await expect(decision).toHaveCount(0);
    expect(decisionSubmissions).toEqual(Array.from({ length: 2 }, () => ({
      action: 'confirm', fingerprint, expectedVersion: 0, idempotencyKey: expect.any(String),
    })));
    expect(decisionSubmissions[1]).toEqual(decisionSubmissions[0]);
    await expect(ownerProposal.getByRole('list', { name: '决定历史' })).toContainText('已批准');
    await language(ownerPage, 'en');
    await expect(ownerProposal.getByRole('status')).toHaveText(translate('en', 'operations.proposal_confirmed'));
    await expect(ownerProposal.getByRole('list', { name: 'Decision history' })).toContainText('Approved');
  } finally {
    await ownerPage.close();
  }

  await page.goto(sourcePage);
  try {
    await launch.click();
    await expect.poll(() => submissions.length).toBe(3);
    const response = page.waitForResponse(startUrl);
    await page.goto(`${stack.origin}/#/projects/${other.id}`);
    late.resolve();
    await response;
    await expect(page.getByRole('heading', { name: other.title, exact: true })).toBeVisible();
    await expect(panel).toHaveCount(0);
  } finally { late.resolve(); }
  await stack.database.admin.query("UPDATE itervane.project_members SET role='viewer' WHERE project_id=$1", [project.id]);
  maintainerCanWrite = false;
  const access = page.waitForResponse(`${stack.origin}/v1/projects/${project.id}/access`);
  await page.goto(sourcePage);
  expect(await (await access).json()).toMatchObject({ canWrite: false });
  await expect(page.getByTestId('release-result')).toBeVisible();
  await expect(launch).toHaveCount(0);
  await page.goto(diagnosticPage);
  await expect(panel.getByText('Exited', { exact: true })).toBeVisible();
  await expect(proposal.getByRole('status')).toHaveText(translate('en', 'operations.proposal_confirmed'));
  await expect(proposal.getByRole('button', { name: 'Withdraw approval', exact: true })).toHaveCount(0);
  await stack.database.admin.query('DELETE FROM itervane.project_members WHERE project_id=$1', [project.id]);
  await expect(panel).toHaveCount(0);
  await expect(page.getByText(receiptSha256, { exact: true })).toHaveCount(0);
  await expectMotionCsp(page);
});

test('queues a restart, revalidates continuation, and displays bilingual recovery receipts', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await observeMotion(page, stack.origin);
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const admitted = await admit(stack, authorization(), project);
  const expired = await admit(stack, authorization(), project);
  await Promise.all([paused(stack, admitted.id), paused(stack, expired.id)]);
  const observedAt = new Date().toISOString();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const manifestDigest = `sha256:${digest('verified image')}`;
  const proofSha256 = digest('verified recovery');
  type Receipt = NonNullable<OperationsRestartExecutionView['execution']>;
  let phase: Receipt['state'] | null = null;
  let version = 5;
  let hasPortalAuthority = true;
  let expiredNeedsReview = false;
  const queuedRequests: unknown[] = [];
  const continuationRequests: unknown[] = [];
  const show = (request: { headers: () => Record<string, string> }): Locale => request.headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';

  async function mount(task: TaskDto, pastDeadline: boolean) {
    const path = `${stack.origin}/v1/tasks/${task.id}`;
    const runId = task.runId;
    const releaseOperationId = randomUUID();
    const applicationId = randomUUID();
    const environmentId = randomUUID();
    const executionId = randomUUID();
    const executionTaskId = randomUUID();
    const executionRunId = randomUUID();
    const proposalId = randomUUID();
    const fingerprint = digest(proposalId);
    const approvalId = randomUUID().replaceAll('-', '');
    const callSha256 = digest(approvalId);
    const evidenceId = digest('recorded container fact');
    const releaseEvidenceId = digest('recorded release fact');
    const decision = { version: 1, action: 'confirm', actorId: randomUUID(), selfConfirmed: true, decidedAt: observedAt };
    const taskVersion = task.version + 2;
    await page.route(path, async route => {
      const response = await route.fetch();
      return response.ok() ? route.fulfill({ json: taskDtoSchema.parse({ ...task, version: taskVersion,
        state: 'succeeded', workflow: 'operations' }) }) : route.fulfill({ response });
    });
    await page.route(`${path}/operations`, route => {
      const locale = show(route.request());
      return route.fulfill({ json: operationsObservationViewSchema.parse({
        version: 1, taskId: task.id, runId, taskVersion, applicationId, environmentId, releaseOperationId,
        state: 'succeeded', observation: { state: 'exited', stateLabel: translate(locale, 'operations.container.exited'), observedAt, receiptSha256: digest('observation') },
        diagnosis: { receiptSha256: digest('diagnosis'), previousReleaseOperationId: null, hypotheses: [],
          recommendation: { code: 'review_restart', message: translate(locale, 'operations.proposal_confirmed'), evidenceIds: [evidenceId, releaseEvidenceId] },
          facts: [
            { section: 'container', evidenceId, proofSha256: digest('container proof'), result: { state: 'exited', observedAt } },
            { section: 'release', evidenceId: releaseEvidenceId, proofSha256: digest('release proof'),
              result: { current: { operationId: releaseOperationId, manifestDigest, verifiedAt: observedAt }, previous: null } },
          ] },
        reason: 'operations_diagnosed', reasonMessage: translate(locale, 'reason.operations_diagnosed'),
        message: translate(locale, 'task.operations_observed'), locale,
      }) });
    });
    await page.route(`${path}/operations-proposal`, route => {
      const locale = show(route.request());
      const status = pastDeadline ? 'expired' : 'confirmed';
      return route.fulfill({ json: operationsProposalViewSchema.parse({ taskId: task.id, runId, taskVersion, locale, draft: null,
        proposal: { id: proposalId, fingerprint, kind: 'restart', status, message: translate(locale, `operations.proposal_${status}`),
          validUntil: new Date(Date.parse(observedAt) + (pastDeadline ? -60_000 : 180_000)).toISOString(),
          current: { operationId: releaseOperationId, manifestDigest }, restore: null, actions: [], decisions: [decision] },
      }) });
    });
    await page.route(`${path}/operations-execution`, route => {
      const locale = show(route.request());
      const state = pastDeadline ? expiredNeedsReview ? 'needs_human' : 'reconciling' : phase;
      const reason = state === 'needs_human' ? 'operations_restart_recovery_manual'
        : pastDeadline ? 'operations_restart_approval_expired' : state === 'waiting_approval' ? 'operations_execution_native_approval'
        : state === 'succeeded' ? 'operations_restart_recovery_verified' : state === 'reconciling' ? 'operations_execution_reconciling'
          : 'operations_execution_queued';
      const execution = state ? { id: executionId, taskId: executionTaskId, runId: executionRunId, taskVersion: version, proposalId, releaseOperationId,
        state, reason, message: translate(locale, `reason.${reason}`), environmentHeld: state !== 'succeeded',
        nativeApprovalId: state === 'queued' ? null : approvalId,
        recovery: state === 'succeeded' ? { state: 'verified', failure: null, proofSha256 }
          : state === 'needs_human' ? { state: 'manual_review', failure: 'native_unconfirmed', proofSha256: null } : null } : null;
      const action = pastDeadline || !hasPortalAuthority ? null : state === null ? { kind: 'enqueue', proposalId, fingerprint, decisionVersion: 1 }
        : state === 'waiting_approval' ? { kind: 'continue', executionId, expectedVersion: version, approvalId, callSha256 } : null;
      return route.fulfill({ json: operationsRestartExecutionViewSchema.parse({ taskId: task.id, runId, locale, execution, action }) });
    });
    if (!pastDeadline) {
      await page.route(`${stack.origin}/v1/operations/proposals/${proposalId}/execution`, route => {
        queuedRequests.push(operationsRestartEnqueueInputSchema.parse(route.request().postDataJSON()));
        phase = 'queued';
        return route.fulfill({ status: 202, json: { executionId, replayed: false } });
      });
      await page.route(`${stack.origin}/v1/operations/executions/${executionId}/continue`, route => {
        continuationRequests.push(operationsRestartContinueInputSchema.parse(route.request().postDataJSON()));
        if (continuationRequests.length === 1) return route.abort('failed');
        phase = 'reconciling';
        return route.fulfill({ status: 202, json: { executionId, replayed: false } });
      });
    }
    return { approvalId, callSha256, fingerprint, destination: `${stack.origin}/#/tasks/${task.id}` };
  }
  const current = await mount(admitted, false);
  await page.goto(current.destination);
  const execution = page.getByTestId('operations-restart-execution');
  const queue = execution.getByRole('button', { name: 'Queue restart', exact: true });
  await queue.click();
  const queueDialog = page.getByRole('dialog', { name: 'Queue this approved restart?' });
  await expect(queueDialog.getByText(manifestDigest, { exact: true })).toBeVisible();
  await queueDialog.getByRole('button', { name: 'Go back', exact: true }).click();
  expect(queuedRequests).toEqual([]);
  await queue.click();
  await queueDialog.getByRole('button', { name: 'Queue restart', exact: true }).click();
  await expect(execution.getByRole('status')).toHaveText(translate('en', 'reason.operations_execution_queued'));
  expect(queuedRequests).toEqual([{ fingerprint: current.fingerprint, decisionVersion: 1 }]);

  phase = 'waiting_approval';
  await language(page, 'zh-CN');
  await expect(execution.getByText(current.approvalId, { exact: true })).toBeVisible();
  const resume = execution.getByRole('button', { name: '续发重启', exact: true });
  await resume.click();
  const resumeDialog = page.getByRole('dialog', { name: '续发本次重启请求？' });
  await expect(resumeDialog.getByText(current.approvalId, { exact: true })).toBeVisible();
  hasPortalAuthority = false;
  await expect(resumeDialog).toHaveCount(0);
  await expect(resume).toHaveCount(0);
  expect(continuationRequests).toEqual([]);
  version++;
  hasPortalAuthority = true;
  await resume.click();
  const submit = resumeDialog.getByRole('button', { name: '续发重启', exact: true });
  await submit.click();
  await expect(resumeDialog.getByRole('alert')).toBeVisible();
  await submit.click();
  await expect(execution.getByRole('status')).toHaveText(translate('zh-CN', 'reason.operations_execution_reconciling'));
  expect(continuationRequests).toHaveLength(2);
  expect(continuationRequests[0]).toEqual({ approvalId: current.approvalId, callSha256: current.callSha256, expectedVersion: version, idempotencyKey: expect.any(String) });
  expect(continuationRequests[1]).toEqual(continuationRequests[0]);
  phase = 'succeeded';
  await expect(execution.getByRole('status')).toHaveText(translate('zh-CN', 'reason.operations_restart_recovery_verified'));
  const disclosures = (await motionProbe(page)).disclosures;
  await execution.locator('summary').filter({ hasText: '重启回执' }).press('Enter');
  await expect(execution.getByText(proofSha256, { exact: true })).toBeVisible();
  await expect.poll(async () => (await motionProbe(page)).disclosures).toBeGreaterThan(disclosures);
  await expect(execution.getByText('已释放', { exact: true })).toBeVisible();

  const past = await mount(expired, true);
  await page.goto(past.destination);
  await expect(execution.getByRole('status')).toHaveText(translate('zh-CN', 'reason.operations_restart_approval_expired'));
  await expect(resume).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await language(page, 'en');
  await expect(execution.getByRole('status')).toHaveText(translate('en', 'reason.operations_restart_approval_expired'));
  const motion = (await motionProbe(page)).disclosures;
  await execution.locator('summary').filter({ hasText: 'Restart receipt' }).press('Enter');
  await expect(execution.getByText('Held by this execution', { exact: true })).toBeVisible();
  expect((await motionProbe(page)).disclosures).toBe(motion);
  expiredNeedsReview = true;
  await expect(execution.getByRole('status')).toHaveText(translate('en', 'reason.operations_restart_recovery_manual'));
  await expect(execution.getByRole('button', { name: 'Resume restart', exact: true })).toHaveCount(0);
  await expectMotionCsp(page);
});

test('rechecks a version restore confirmation and displays its bilingual receipt', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await observeMotion(page, stack.origin);
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project);
  await paused(stack, task.id);
  const observedAt = new Date().toISOString();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const taskVersion = task.version + 2;
  const proposalId = randomUUID();
  const executionId = randomUUID();
  const coordinates = { id: executionId, taskId: randomUUID(), runId: randomUUID(), proposalId, taskVersion: 1 };
  const updateId = '8'.repeat(24);
  const proofSha256 = digest('verified version restore');
  const current = { operationId: randomUUID(), manifestDigest: `sha256:${digest('new image')}` };
  const restore = { operationId: randomUUID(), manifestDigest: `sha256:${digest('original image')}` };
  const payload = { fingerprint: digest(proposalId), decisionVersion: 1 };
  const path = `${stack.origin}/v1/tasks/${task.id}`;
  const localeOf = (request: { headers: () => Record<string, string> }): Locale => request.headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
  const requests: unknown[] = [];
  let maySubmit = false;
  let state: 'queued' | 'succeeded' | null = null;
  await page.route(path, async route => {
    const response = await route.fetch();
    return response.ok() ? route.fulfill({ json: taskDtoSchema.parse({ ...task, version: taskVersion,
      state: 'succeeded', workflow: 'operations' }) }) : route.fulfill({ response });
  });
  await page.route(`${path}/operations`, route => {
    const locale = localeOf(route.request());
    const containerEvidence = digest('restore diagnosis container');
    const releaseEvidence = digest('restore diagnosis release');
    return route.fulfill({ json: operationsObservationViewSchema.parse({ version: 1, taskId: task.id, runId: task.runId, taskVersion,
      applicationId: randomUUID(), environmentId: randomUUID(), releaseOperationId: current.operationId, state: 'succeeded',
      observation: { state: 'exited', stateLabel: translate(locale, 'operations.container.exited'), observedAt, receiptSha256: digest('observation') },
      diagnosis: { receiptSha256: digest('diagnosis'), previousReleaseOperationId: restore.operationId, hypotheses: [],
        recommendation: { code: 'review_rollback', message: translate(locale, 'operations.proposal_confirmed'), evidenceIds: [containerEvidence, releaseEvidence] },
        facts: [{ section: 'container', evidenceId: containerEvidence, proofSha256: digest('container proof'), result: { state: 'exited', observedAt } },
          { section: 'release', evidenceId: releaseEvidence, proofSha256: digest('release proof'), result: {
            current: { ...current, verifiedAt: observedAt }, previous: { ...restore, verifiedAt: observedAt },
          } }],
      }, reason: 'operations_diagnosed', reasonMessage: translate(locale, 'reason.operations_diagnosed'),
      message: translate(locale, 'task.operations_observed'), locale,
    }) });
  });
  const decision = { version: 1, action: 'confirm', actorId: randomUUID(), selfConfirmed: true, decidedAt: observedAt };
  await page.route(`${path}/operations-proposal`, route => {
    const locale = localeOf(route.request());
    return route.fulfill({ json: operationsProposalViewSchema.parse({ taskId: task.id, runId: task.runId, taskVersion, locale, draft: null,
      proposal: { id: proposalId, fingerprint: payload.fingerprint, kind: 'rollback', status: 'confirmed',
        message: translate(locale, 'operations.proposal_confirmed'), validUntil: new Date(Date.parse(observedAt) + 300_000).toISOString(),
        current, restore, actions: [], decisions: [decision] },
    }) });
  });
  await page.route(`${path}/operations-restore`, route => {
    const locale = localeOf(route.request());
    const verified = state === 'succeeded';
    const reason = verified ? 'operations_restore_recovery_verified' : 'operations_execution_queued';
    const execution = state ? { ...coordinates, releaseOperationId: current.operationId, restore, state, reason,
      message: translate(locale, `reason.${reason}`), environmentHeld: !verified, nativeUpdateId: verified ? updateId : null,
      recovery: verified ? { state: 'verified', failure: null, proof: { proofSha256, version: 'standard-v2', verifiedAt: observedAt } } : null,
    } : null;
    return route.fulfill({ json: operationsRestoreExecutionViewSchema.parse({ taskId: task.id, runId: task.runId, locale, execution,
      action: maySubmit && !state ? { kind: 'enqueue', proposalId, ...payload } : null,
    }) });
  });
  await page.route(`${stack.origin}/v1/operations/proposals/${proposalId}/restore`, route => {
    requests.push(operationsEnqueueInputSchema.parse(route.request().postDataJSON()));
    state = 'queued';
    return route.fulfill({ status: 202, json: { executionId, replayed: false } });
  });

  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  const execution = page.getByTestId('operations-restore-execution');
  const queue = execution.getByRole('button', { name: 'Queue version restore', exact: true });
  await expect(page.getByTestId('operations-proposal')).toBeVisible();
  await expect(queue).toHaveCount(0);
  maySubmit = true;
  await queue.click();
  const dialog = page.getByRole('dialog', { name: 'Queue this approved version restore?' });
  await expect(dialog.getByText(restore.manifestDigest, { exact: true })).toBeVisible();
  maySubmit = false;
  await expect(dialog).toHaveCount(0);
  expect(requests).toEqual([]);
  maySubmit = true;
  await queue.click();
  await dialog.getByRole('button', { name: 'Queue version restore', exact: true }).click();
  await expect(execution.getByRole('status')).toHaveText(translate('en', 'reason.operations_execution_queued'));
  expect(requests).toEqual([payload]);
  state = 'succeeded';
  await language(page, 'zh-CN');
  await expect(execution.getByRole('status')).toHaveText(translate('zh-CN', 'reason.operations_restore_recovery_verified'));
  const disclosures = (await motionProbe(page)).disclosures;
  await execution.locator('summary').filter({ hasText: '版本恢复回执' }).press('Enter');
  await expect(execution.getByText('standard-v2', { exact: true })).toBeVisible();
  await expect(execution.getByText(updateId, { exact: true })).toBeVisible();
  await expect(execution.getByText(proofSha256, { exact: true })).toBeVisible();
  await expect(execution.getByText('已释放', { exact: true })).toBeVisible();
  await expect.poll(async () => (await motionProbe(page)).disclosures).toBeGreaterThan(disclosures);
  await expect(execution.getByRole('button', { name: '提交版本恢复', exact: true })).toHaveCount(0);
  await expectMotionCsp(page);
});

test('follows the bilingual health event, stops diagnosis and confirms the fixed repair source', async ({ page, stack }) => {
  const project = await seedProject(stack);
  const authorization = authorizationFrom(page);
  await login(page, stack);
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const delivery = await admit(stack, authorization(), project);
  const diagnosis = taskDtoSchema.parse({ ...await admit(stack, authorization(), project), workflow: 'operations', state: 'succeeded' });
  const linked = await admit(stack, authorization(), project);
  const { candidate, target } = frozenReleaseFixture(delivery);
  const scope = { projectId: project.id, environmentId: target.environmentId };
  const releaseOperationId = randomUUID();
  const restoreExecutionId = randomUUID();
  const incidentId = randomUUID();
  const proposalId = randomUUID();
  const sampleTime = new Date().toISOString();
  const materializedCommit = 'e'.repeat(40);
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const diagnosisSha256 = hash('verified application diagnosis');
  const fingerprint = hash('frozen linked repair');
  const containerEvidence = hash('container');
  const releaseEvidence = hash('release');
  const api = `${stack.origin}/v1`;
  const releasePath = `${api}/tasks/${delivery.id}`;
  const diagnosisPath = `${api}/tasks/${diagnosis.id}`;
  const historyPath = `${api}/projects/${scope.projectId}/environments/${scope.environmentId}/operations-incidents`;
  const localeFor = (request: { headers: () => Record<string, string> }): Locale => request.headers()['accept-language'] === 'zh-CN' ? 'zh-CN' : 'en';
  const stops: unknown[] = [];
  const prepares: unknown[] = [];
  const approvals: unknown[] = [];
  let mayConfirm = true;
  const latestSample = (locale: Locale) => ({ sequence: 7, recordedAt: sampleTime, releaseOperationId, restoreExecutionId,
    signal: { status: 'unhealthy' as const, reason: 'application_unhealthy' as const, evidenceSha256: hash('unhealthy sample') },
    message: translate(locale, 'operations.health.application_unhealthy') });
  const incident = (locale: Locale) => ({ id: incidentId, releaseOperationId, restoreExecutionId, openedAt: sampleTime, lastUnhealthyAt: sampleTime,
    unhealthySamples: 2, closedAt: null, closedReason: null, latestSample: latestSample(locale), message: translate(locale, 'operations.incident.open'),
    diagnosisStop: stops.length ? { at: sampleTime, reason: 'operator_stopped' as const, message: translate(locale, 'operations.incident.operator_stopped') } : null,
    diagnoses: [{ taskId: diagnosis.id, runId: diagnosis.runId, attempt: 1, sampleSequence: 7, state: 'succeeded' as const, stateLabel: translate(locale, 'state.succeeded') }],
    repairs: approvals.length ? [{ proposalId, diagnosisRunId: diagnosis.runId, taskId: linked.id, state: 'queued' as const }] : [],
  });
  await page.route(releasePath, async route => {
    const response = await route.fetch();
    return response.ok() ? route.fulfill({ json: { ...delivery, state: 'succeeded' } }) : route.fulfill({ response });
  });
  await page.route(`${releasePath}/release`, route => {
    const locale = localeFor(route.request());
    return route.fulfill({ json: formalReleaseViewSchema.parse({ taskId: delivery.id, taskVersion: delivery.version, runId: delivery.runId,
      candidate: { ...candidate, status: 'confirmed', operationId: releaseOperationId }, candidateTarget: target, availableTargets: [], actions: [],
      result: { operationId: releaseOperationId, candidateId: candidate.id, updateId: 'a'.repeat(24), status: 'verified', locale,
        message: translate(locale, 'release.operation.verified_formal'), evidence: { checkedAt: sampleTime,
          manifestDigest: candidate.manifest.image.manifestDigest, configDigest: candidate.manifest.image.configDigest,
          version: 'standard-v2', healthy: true, accessProtected: true } },
    }) });
  });
  await page.route(historyPath, route => {
    const locale = localeFor(route.request());
    return route.fulfill({ json: operationsIncidentsViewSchema.parse({ version: 1, ...scope, locale, latestHealth: latestSample(locale), items: [incident(locale)] }) });
  });
  await page.route(diagnosisPath, async route => {
    const response = await route.fetch();
    return response.ok() ? route.fulfill({ json: diagnosis }) : route.fulfill({ response });
  });
  await page.route(`${diagnosisPath}/operations`, route => {
    const locale = localeFor(route.request());
    return route.fulfill({ json: operationsObservationViewSchema.parse({
      version: 1, taskId: diagnosis.id, runId: diagnosis.runId, taskVersion: diagnosis.version, state: diagnosis.state,
      applicationId: target.applicationId, environmentId: scope.environmentId, releaseOperationId,
      observation: { state: 'running', stateLabel: translate(locale, 'operations.container.running'), observedAt: sampleTime, receiptSha256: hash('observed') },
      diagnosis: { receiptSha256: diagnosisSha256, previousReleaseOperationId: null, hypotheses: [], recommendation: {
        code: 'investigate_code', message: locale === 'zh-CN' ? '排查导致此故障的源码。' : 'Investigate the source of this failure.',
        evidenceIds: [containerEvidence, releaseEvidence],
      }, facts: [
        { section: 'container', evidenceId: containerEvidence, proofSha256: hash('container proof'), result: { state: 'running', observedAt: sampleTime } },
        { section: 'release', evidenceId: releaseEvidence, proofSha256: hash('release proof'), result: {
          current: { operationId: releaseOperationId, manifestDigest: candidate.manifest.image.manifestDigest, verifiedAt: sampleTime }, previous: null,
        } },
      ] }, locale, message: translate(locale, 'task.operations_observed'), reason: 'operations_diagnosed', reasonMessage: translate(locale, 'reason.operations_diagnosed'),
    }) });
  });
  await page.route(`${diagnosisPath}/operations-incident`, route => {
    const locale = localeFor(route.request());
    return route.fulfill({ json: taskIncidentViewSchema.parse({ version: 1, taskId: diagnosis.id, locale, relatedAs: 'diagnosis',
      incident: incident(locale), stopDiagnosis: stops.length ? null : scope }) });
  });
  await page.route(`${api}/tasks/${linked.id}/operations-incident`, route => {
    const locale = localeFor(route.request());
    return route.fulfill({ json: taskIncidentViewSchema.parse({ version: 1, taskId: linked.id, locale, relatedAs: 'linked_repair', incident: incident(locale) }) });
  });
  await page.route(`${historyPath}/${incidentId}/stop-diagnosis`, route => {
    stops.push(stopOperationsIncidentDiagnosisSchema.parse(route.request().postDataJSON()));
    const locale = localeFor(route.request());
    return route.fulfill({ json: operationsIncidentStopResultSchema.parse({ incidentId, stoppedAt: sampleTime, replayed: false,
      locale, reason: 'operator_stopped', message: translate(locale, 'operations.incident.operator_stopped') }) });
  });
  await page.route(`${diagnosisPath}/operations-repair`, route => {
    const request = route.request();
    if (request.method() === 'POST') prepares.push(request.postDataJSON());
    const locale = localeFor(request);
    const status = approvals.length ? 'confirmed' : 'pending';
    return route.fulfill({ json: operationsRepairViewSchema.parse({ taskId: diagnosis.id, runId: diagnosis.runId, taskVersion: diagnosis.version, locale,
      draft: prepares.length ? null : { diagnosisSha256 }, proposal: prepares.length ? {
        id: proposalId, fingerprint, status, validUntil: new Date(Date.parse(sampleTime) + 300_000).toISOString(), incidentId,
        message: translate(locale, `operations.linked_repair.${status}`), mayConfirm: mayConfirm && status === 'pending',
        target: { environmentId: scope.environmentId, releaseOperationId, restoreExecutionId }, source: { ...diagnosis.source, requiresMaterializedCommit: true },
        linkedTask: approvals.length ? { taskId: linked.id, runId: linked.runId, state: 'queued', stateLabel: translate(locale, 'state.queued') } : null,
      } : null,
    }) });
  });
  await page.route(`${api}/operations/repair-proposals/${proposalId}/confirm`, route => {
    approvals.push(confirmOperationsRepairSchema.parse(route.request().postDataJSON()));
    return route.fulfill({ status: 202, json: { task: { ...linked, source: { ...linked.source, commit: materializedCommit } }, replayed: false } });
  });

  await page.goto(`${stack.origin}/#/tasks/${delivery.id}`);
  page.setDefaultTimeout(8_000);
  const history = page.getByTestId('release-health-history');
  await expect(history.getByRole('status')).toHaveText(translate('en', 'operations.health.application_unhealthy'));
  await history.locator('summary').filter({ hasText: 'Health event history' }).press('Enter');
  await history.getByRole('link', { name: 'Diagnosis attempt 1' }).click();
  const card = page.getByTestId('task-health-incident');
  await card.getByRole('button', { name: 'Stop automatic diagnosis' }).click();
  const stop = page.getByRole('dialog', { name: 'Stop automatic diagnosis for this incident?' });
  await expect(stop.getByText(restoreExecutionId, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stop).toHaveCount(0);
  expect(stops).toEqual([]);

  await language(page, 'zh-CN');
  await card.getByRole('button', { name: '停止自动诊断', exact: true }).click();
  await page.getByRole('dialog', { name: '停止此事件的自动诊断？' }).getByRole('button', { name: '停止自动诊断', exact: true }).click();
  await expect(card.getByText(translate('zh-CN', 'operations.incident.operator_stopped'), { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: '停止自动诊断', exact: true })).toHaveCount(0);
  expect(stops).toEqual([{ expectedReleaseOperationId: releaseOperationId, expectedRestoreExecutionId: restoreExecutionId }]);

  const repair = page.getByTestId('operations-linked-repair');
  await repair.getByRole('button', { name: '准备关联修复' }).click();
  await repair.getByRole('button', { name: '提交关联修复' }).click();
  expect(prepares).toEqual([{ diagnosisSha256 }]);
  const confirm = page.getByRole('dialog', { name: '为此版本提交修复任务？' });
  const commit = confirm.getByRole('textbox', { name: '包含已部署补丁的提交' });
  const queue = confirm.getByRole('button', { name: '提交关联修复' });
  await commit.fill(diagnosis.source.commit);
  await expect(queue).toBeDisabled();
  mayConfirm = false;
  await expect(confirm).toHaveCount(0);
  expect(approvals).toEqual([]);
  mayConfirm = true;
  await repair.getByRole('button', { name: '提交关联修复' }).click();
  await commit.fill(materializedCommit);
  await expect(queue).toBeEnabled();
  await queue.press('Enter');
  await expect(repair.getByRole('link', { name: '关联修复任务' })).toHaveAttribute('href', `#/tasks/${linked.id}`);
  expect(approvals).toEqual([{ fingerprint, locale: 'zh-CN', commit: materializedCommit }]);
  await language(page, 'en');
  await expect(repair.getByText(translate('en', 'operations.linked_repair.confirmed'), { exact: true })).toBeVisible();
  await repair.getByRole('link', { name: 'Linked repair task' }).click();
  await expect(page).toHaveURL(new RegExp(`#/tasks/${linked.id}$`));
  await expect(card.getByRole('link', { name: 'Diagnosis attempt 1' })).toHaveAttribute('href', `#/tasks/${diagnosis.id}`);
});

for (const locale of ['en', 'zh-CN'] as const) test(`real OIDC and task lifecycle in ${locale}`, async ({ page, stack }) => {
  const zh = locale === 'zh-CN';
  await observeMotion(page, stack.origin);
  let challenge = false;
  let identityMatches = false;
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/protocol/openid-connect/auth')) challenge = url.searchParams.get('code_challenge_method') === 'S256';
    if (url.pathname === '/v1/me') {
      const parts = request.headers().authorization?.slice(7).split('.');
      if (parts?.length === 3) {
        const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { typ?: string; alg?: string };
        const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { typ?: string; aud?: unknown; iss?: string; sub?: string; exp?: number; iat?: number };
        identityMatches = header.typ === 'JWT' && header.alg === 'RS256' && claims.typ === 'Bearer'
          && (Array.isArray(claims.aud) ? claims.aud.includes('itervane-api') : claims.aud === 'itervane-api')
          && claims.iss === stack.issuer && claims.sub === stack.ownerId;
      }
    }
  });
  await login(page, stack, 'owner', locale);
  await expect(page.getByRole('heading', { name: zh ? '项目' : 'Projects', exact: true })).toBeVisible(); expect(challenge).toBe(true); expect(identityMatches).toBe(true);
  expect(new URL(page.url()).search).toBe('');
  const title = `Browser ${locale} ${randomUUID().slice(0, 6)}`;
  flowPhase('project');
  await page.getByRole('button', { name: zh ? '创建项目' : 'Create project', exact: true }).click();
  await page.getByLabel(zh ? '项目名称' : 'Project name', { exact: true }).fill(title);
  await page.getByLabel(zh ? '项目标识' : 'Project slug', { exact: true }).fill(`browser-${randomUUID().slice(0, 8)}`);
  await page.getByRole('dialog').getByRole('button', { name: zh ? '创建项目' : 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  flowPhase('repository');
  await page.getByRole('button', { name: zh ? '登记仓库' : 'Register repository', exact: true }).click();
  await page.getByLabel(zh ? '仓库名称' : 'Repository name', { exact: true }).fill('Reference source');
  await page.getByLabel(zh ? 'HTTPS 仓库地址' : 'HTTPS repository URL', { exact: true }).fill('https://example.invalid/browser.git');
  await page.getByRole('button', { name: zh ? '保存仓库' : 'Save repository', exact: true }).click();
  await expect(page.getByText('https://example.invalid/browser.git', { exact: true })).toBeVisible();
  flowPhase('task');
  await page.getByRole('button', { name: zh ? '发起前置检查' : 'Start preflight', exact: true }).click();
  await page.getByLabel(zh ? '完整 Git 版本' : 'Full Git commit', { exact: true }).fill('a'.repeat(40));
  const purpose = `Inspect ${locale} <img src=x onerror=alert(1)>`;
  await page.getByLabel(zh ? '任务目标' : 'Task goal', { exact: true }).fill(purpose);
  await page.getByRole('button', { name: zh ? '提交任务' : 'Queue task', exact: true }).click();
  await expect(page.getByRole('heading', { name: zh ? '任务详情' : 'Task details', exact: true })).toBeVisible();
  flowPhase('inspection');
  await expect(page.getByText(zh ? '任务正在等待经过验证的 Runner。' : 'Task is waiting for a verified Runner.', { exact: true })).toBeVisible();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  const taskId = page.url().split('/').at(-1)!;
  flowPhase('mcp');
  const client = new Client({ name: 'itervane-browser-cross-check', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await stack.mcpToken()}` } } }));
    const task = taskDtoSchema.parse((await client.callTool({ name: 'get_task', arguments: { taskId } })).structuredContent);
    expect(task).toMatchObject({ id: taskId, state: 'waiting_input', locale, purpose });
    const inspection = sourceInspectionDtoSchema.parse((await client.callTool({ name: 'get_source_inspection', arguments: { taskId } })).structuredContent);
    expect(inspection).toMatchObject({ taskId, status: 'blocked', sourceFetched: false, snapshotVerified: false, scanCompleted: false });
    await expect(page.getByTestId('source-inspection')).toContainText(zh ? '计划已准备，执行仍被阻断' : 'Plan prepared; execution is blocked');
    await expect(page.getByTestId('source-inspection')).toContainText(inspection.plan!.sha256);
    await expect(page.getByTestId('source-inspection').getByText(zh ? '请求的版本' : 'Requested commit', { exact: true })).toBeVisible();
    const audit = formalAuditDtoSchema.parse((await client.callTool({ name: 'get_audit', arguments: { taskId } })).structuredContent);
    expect(audit).toMatchObject({ taskId, status: 'pending', result: null });
    await expect(page.getByTestId('formal-audit')).toContainText(zh ? '审计结果入库后，可在此查看清单。' : 'The checklist will appear when the audit result is recorded.');
  } finally { await client.close(); }
  const storageSafe = await page.evaluate(() => {
    const entries = [...Object.keys(localStorage).map(key => localStorage.getItem(key) ?? ''), ...Object.keys(sessionStorage).map(key => sessionStorage.getItem(key) ?? '')];
    return entries.every(value => !/access_token|refresh_token|id_token|eyJ[A-Za-z0-9_-]+\./.test(value));
  });
  expect(storageSafe).toBe(true);
  flowPhase('capture');
  await page.screenshot({ path: `.reports/p1-c/portal-${locale}.png`, fullPage: true });
  flowPhase('resume');
  const retry = page.getByRole('button', { name: zh ? '重试前置检查' : 'Retry preflight', exact: true });
  const confirm = page.getByRole('button', { name: zh ? '确认重试' : 'Confirm retry', exact: true });
  const back = page.getByRole('button', { name: zh ? '暂不操作' : 'Go back', exact: true });
  const dialog = page.getByRole('dialog', { name: zh ? '确认重试前置检查？' : 'Retry this preflight?', exact: true });
  for (const width of [375, 768, 1365]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await captureWorkspace(page, `.reports/p1-shadcn/task-mobile-${locale}.png`);
  await retry.focus(); await retry.press('Enter');
  await expect(dialog).toBeVisible(); await expect(back).toBeFocused();
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  await page.keyboard.press('Shift+Tab'); await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab'); await expect(back).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(retry).toBeFocused();
  expect((await stack.database.admin.query('SELECT resume_count FROM itervane.run_runtime WHERE task_id=$1', [taskId])).rows[0]?.resume_count).toBe(0);
  await page.setViewportSize({ width: 1365, height: 960 });
  await retry.press('Enter');
  await confirm.click();
  await expect.poll(async () => (await stack.database.admin.query('SELECT resume_count FROM itervane.run_runtime WHERE task_id=$1', [taskId])).rows[0]?.resume_count).toBe(1);
  await expect(page.getByText(zh ? '任务正在等待经过验证的 Runner。' : 'Task is waiting for a verified Runner.', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: zh ? '重试前置检查' : 'Retry preflight', exact: true })).toBeVisible();
  expect((await stack.database.admin.query('SELECT count(*)::int AS count FROM itervane.inspection_plans WHERE task_id=$1', [taskId])).rows[0]?.count).toBe(1);
  flowPhase('localization'); await language(page, zh ? 'en' : 'zh-CN');
  await expect(page.getByTestId('task-locale')).toHaveText(zh ? '简体中文' : 'English');
  flowPhase('cancel');
  await page.getByRole('button', { name: zh ? 'Cancel task' : '取消任务', exact: true }).click();
  await page.getByRole('button', { name: zh ? 'Confirm cancellation' : '确认取消', exact: true }).click();
  await expect.poll(async () => (await stack.database.admin.query('SELECT state FROM itervane.tasks WHERE id=$1', [taskId])).rows[0]?.state).toBe('cancelled');
  await expectMotionCsp(page);
  expect(await motionProbe(page)).toMatchObject({ headings: 0, state: 0, events: 0 });
  flowPhase('logout');
  await page.getByRole('button', { name: zh ? 'Sign out' : '退出登录', exact: true }).click();
  const logoutConfirmation = page.locator('#kc-logout');
  const signedOut = page.getByText(zh ? 'You have signed out.' : '你已退出登录。', { exact: true });
  await Promise.race([logoutConfirmation.waitFor({ state: 'visible' }), signedOut.waitFor({ state: 'visible' })]);
  if (await logoutConfirmation.isVisible()) await logoutConfirmation.click();
  await expect(signedOut).toBeVisible();
  await expect(page.getByRole('button', { name: zh ? 'Sign in' : '登录平台', exact: true })).toBeVisible();
  await expect(page.getByText(purpose, { exact: true })).toHaveCount(0);
});

test('invalid callbacks are cleared and cannot enroll an anonymous administrator', async ({ page, stack }) => {
  await page.goto(`${stack.origin}/auth/callback?code=synthetic-invalid-code&state=synthetic-invalid-state`);
  await expect(page.getByText('This sign-in response is invalid or has expired. Start a new sign-in.', { exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toHaveCount(0);
});

test('a real signed-in but unregistered account is refused', async ({ page, stack }) => {
  await login(page, stack, 'stranger');
  await expect(page.getByText('This account has not been granted workspace access.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toHaveCount(0);
});

test('current project roles govern visible actions and revoked membership removes private content', async ({ page, stack }) => {
  const project = await seedProject(stack, true); const authorization = authorizationFrom(page);
  await login(page, stack, 'viewer');
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: project.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: project.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Register repository', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start preflight', exact: true })).toHaveCount(0);
  const denied = await fetch(`${stack.origin}/v1/projects/${project.id}/repositories`, { method: 'POST', headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Denied', url: 'https://example.invalid/denied.git' }) });
  expect(denied.status).toBe(403);
  await stack.database.admin.query("UPDATE itervane.project_members SET role='maintainer' WHERE project_id=$1", [project.id]);
  await expect(page.getByRole('button', { name: 'Register repository', exact: true })).toBeVisible();
  await stack.database.admin.query('DELETE FROM itervane.project_members WHERE project_id=$1', [project.id]);
  await expect(page.getByRole('heading', { name: project.title, exact: true })).toHaveCount(0);
  await expect(page.getByText('https://example.invalid/boundary.git', { exact: true })).toHaveCount(0);
  expect((await fetch(`${stack.origin}/v1/projects/${project.id}`, { headers: { Authorization: authorization() } })).status).toBe(404);
});

test('an accepted request with a lost response retries the same key without creating another task', async ({ page, stack }) => {
  const project = await seedProject(stack); let lost = false; const attempts: unknown[] = [];
  await page.route(`${stack.origin}/v1/tasks`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    attempts.push(route.request().postDataJSON());
    if (!lost) { lost = true; const response = await route.fetch(); expect(response.status()).toBe(202); await route.abort('connectionfailed'); }
    else await route.continue();
  });
  await login(page, stack); await page.getByRole('link', { name: project.title, exact: true }).click();
  await page.getByRole('button', { name: 'Start preflight', exact: true }).click();
  await page.getByLabel('Full Git commit', { exact: true }).fill('c'.repeat(40));
  await page.getByLabel('Task goal', { exact: true }).fill('Lost response');
  await page.getByRole('button', { name: 'Queue task', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same request', exact: true })).toBeVisible();
  await expect(page.getByLabel('Task goal', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task details', exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect((await stack.database.admin.query('SELECT count(*)::int AS count FROM itervane.tasks WHERE project_id=$1', [project.id])).rows[0]?.count).toBe(1);
});

test('a stale confirmation receives a real conflict and requires another explicit confirmation', async ({ page, stack }) => {
  const project = await seedProject(stack); const authorization = authorizationFrom(page); await login(page, stack);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project); await paused(stack, task.id);
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  // A hard reload intentionally discards browser tokens; the real IdP reuses its SSO session.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Task details', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry preflight', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  const current = taskDtoSchema.parse(await (await fetch(`${stack.origin}/v1/tasks/${task.id}`, { headers: { Authorization: authorization() } })).json());
  const resumed = await fetch(`${stack.origin}/v1/tasks/${task.id}/resume`, { method: 'POST', headers: { Authorization: authorization(), 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: current.version }) });
  expect(resumed.status).toBe(200); await paused(stack, task.id);
  const conflict = page.waitForResponse(response => response.url().endsWith(`/tasks/${task.id}/cancel`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(page.getByText('The task changed. Review its latest state before confirming again.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await stack.database.admin.query('SELECT state FROM itervane.tasks WHERE id=$1', [task.id])).rows[0]?.state).toBe('waiting_input');
  const release = Promise.withResolvers<void>();
  let posts = 0;
  await page.route(`${stack.origin}/v1/tasks/${task.id}/cancel`, async route => {
    posts++; await release.promise; await route.continue();
  });
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Confirm cancellation', exact: true });
  try {
    await confirm.click();
    await expect.poll(() => posts).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(confirm).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Go back', exact: true })).toBeDisabled();
  } finally { release.resolve(); }
  await expect.poll(async () => (await stack.database.admin.query('SELECT state FROM itervane.tasks WHERE id=$1', [task.id])).rows[0]?.state).toBe('cancelled');
  expect(posts).toBe(1);
});

test('task confirmation closes when the current project role becomes read only', async ({ page, stack }) => {
  const project = await seedProject(stack, true); const authorization = authorizationFrom(page);
  await stack.database.admin.query("UPDATE itervane.project_members SET role='maintainer' WHERE project_id=$1", [project.id]);
  await login(page, stack, 'viewer');
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project); await paused(stack, task.id);
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel this task?' });
  await expect(dialog).toBeVisible();
  await stack.database.admin.query("UPDATE itervane.project_members SET role='viewer' WHERE project_id=$1", [project.id]);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel task', exact: true })).toHaveCount(0);
  await expect(page.getByText(task.purpose, { exact: true })).toBeVisible();
  const denied = await fetch(`${stack.origin}/v1/tasks/${task.id}/cancel`, { method: 'POST',
    headers: { Authorization: authorization(), 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: task.version }) });
  expect(denied.status).toBe(403);
  await stack.database.admin.query('DELETE FROM itervane.project_members WHERE project_id=$1', [project.id]);
  await expect(page.getByText(task.purpose, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('source-inspection')).toHaveCount(0);
});

test('real refresh is serialized and a revoked IdP session clears private views', async ({ page, stack }) => {
  const project = await seedProject(stack); let refreshToken = ''; let active = 0; let maximum = 0; let refreshed = 0;
  const inFlight = new Set<object>();
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/protocol/openid-connect/token') && request.postData()?.includes('grant_type=refresh_token')) {
      inFlight.add(request); maximum = Math.max(maximum, ++active);
    }
  });
  const finished = (request: object) => { if (inFlight.delete(request)) active--; };
  page.on('requestfinished', finished); page.on('requestfailed', finished);
  page.on('response', async response => {
    if (!new URL(response.url()).pathname.endsWith('/protocol/openid-connect/token') || !response.ok()) return;
    const body = await response.json() as { refresh_token?: string }; if (body.refresh_token) { refreshToken = body.refresh_token; refreshed++; }
  });
  await login(page, stack); await page.getByRole('link', { name: project.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: project.title, exact: true })).toBeVisible();
  await expect.poll(() => refreshed).toBeGreaterThan(1); expect(maximum).toBe(1);
  const revoked = await fetch(`${stack.issuer}/protocol/openid-connect/logout`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'itervane-portal', refresh_token: refreshToken }) });
  expect(revoked.status).toBe(204);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Your session has ended. Sign in again to continue.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: project.title, exact: true })).toHaveCount(0);
  await expect(page.getByText('https://example.invalid/boundary.git', { exact: true })).toHaveCount(0);
});

test('the bilingual portal remains usable on a narrow viewport without page overflow', async ({ page, stack }) => {
  const project = await seedProject(stack); const longSlug = 'w'.repeat(64);
  await stack.database.admin.query('UPDATE itervane.projects SET slug=$1 WHERE id=$2', [longSlug, project.id]);
  await page.setViewportSize({ width: 390, height: 844 }); await login(page, stack, 'owner', 'zh-CN');
  await expect(page.getByRole('heading', { name: '项目', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: project.title, exact: true })).toBeVisible();
  await expect(page.getByText(longSlug, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByText('请填写此项。', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('项目名称', { exact: true })).toBeFocused();
  await page.screenshot({ path: '.reports/p1-c/portal-mobile-zh.png', fullPage: true });
});

for (const locale of ['en', 'zh-CN'] as const) test(`real rules and preaudit lifecycle in ${locale}`, async ({ page, stack }) => {
  const zh = locale === 'zh-CN'; const project = await seedProject(stack);
  await observeMotion(page, stack.origin);
  await openPreaudit(page, stack, project, locale);
  const canary = `source-private-${randomUUID()}`;
  const source = `eval(value); // ${canary}\nnode.innerHTML = value;\n// gitleaks:allow\n<img src=x onerror=alert(1)>`;
  await page.getByLabel(zh ? '提供的文本' : 'Supplied text', { exact: true }).fill(source);
  await page.getByRole('button', { name: zh ? '记录预审' : 'Record preaudit', exact: true }).click();
  await expect(page.getByRole('heading', { name: zh ? '文本预审报告' : 'Text preaudit report', exact: true })).toBeVisible();
  const id = page.url().split('/').at(-1)!;
  const client = new Client({ name: 'itervane-preaudit-browser', version: '0.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${stack.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${await stack.mcpToken()}`, 'Accept-Language': locale } } }));
    const report = preauditDtoSchema.parse((await client.callTool({ name: 'get_preaudit', arguments: { preauditId: id } })).structuredContent);
    expect(report).toMatchObject({ id, projectId: project.id, formalScan: false, releaseEligible: false, input: { sha256: createHash('sha256').update(source).digest('hex') } });
    expect(report.observations).toHaveLength(3); expect(JSON.stringify(report)).not.toContain(canary);
  } finally { await client.close(); }
  expect(JSON.stringify((await stack.database.admin.query('SELECT document FROM itervane.preaudits WHERE id=$1', [id])).rows)).not.toContain(canary);
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(value => JSON.stringify([localStorage, sessionStorage]).includes(value), canary)).toBe(false);
  await page.screenshot({ path: `.reports/p1-e/preaudit-${locale}.png`, fullPage: true });
  await language(page, zh ? 'en' : 'zh-CN');
  await expect(page.getByRole('heading', { name: zh ? 'Text preaudit report' : '文本预审报告', exact: true })).toBeVisible();
  await page.getByRole('link', { name: zh ? /Back to rules and preaudit$/ : /返回规则与预审$/ }).click();
  await expect(page.getByRole('link', { name: id.slice(0, 8), exact: true })).toBeVisible();
  await expect(page.getByLabel(zh ? 'Supplied text' : '提供的文本', { exact: true })).toBeEmpty();
  await expectMotionCsp(page);
});

test('preaudit retries an accepted request after response loss with the original key and no second record', async ({ page, stack }) => {
  const project = await seedProject(stack); let lost = false; const attempts: unknown[] = [];
  await page.route(`${stack.origin}/v1/preaudits`, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    attempts.push(route.request().postDataJSON());
    if (!lost) { lost = true; const response = await route.fetch(); expect(response.status()).toBe(201); await route.abort('connectionfailed'); }
    else await route.continue();
  });
  await openPreaudit(page, stack, project);
  await page.getByLabel('Supplied text', { exact: true }).fill('eval(value);'); await page.getByRole('button', { name: 'Record preaudit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same request', exact: true })).toBeVisible();
  await expect(page.getByLabel('Supplied text', { exact: true })).toBeDisabled();
  await language(page, 'zh-CN');
  await expect(page.getByLabel('提供的文本', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('提供的文本', { exact: true })).toHaveValue('eval(value);');
  await page.getByRole('button', { name: '重试同一请求', exact: true }).click();
  await expect(page.getByRole('heading', { name: '文本预审报告', exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
  expect((await stack.database.admin.query('SELECT count(*)::int AS count FROM itervane.preaudits WHERE project_id=$1', [project.id])).rows[0]?.count).toBe(1);
});

test('preaudit readers cannot create reports and revoked membership hides the rule page', async ({ page, stack }) => {
  const project = await seedProject(stack, true); const authorization = authorizationFrom(page);
  await openPreaudit(page, stack, project, 'en', 'viewer');
  await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record preaudit', exact: true })).toHaveCount(0);
  const catalog = catalogDtoSchema.parse(await (await fetch(`${stack.origin}/v1/projects/${project.id}/rules`, { headers: { Authorization: authorization() } })).json());
  const denied = await fetch(`${stack.origin}/v1/preaudits`, { method: 'POST', headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, idempotencyKey: randomUUID(), catalogSha256: catalog.sha256, language: 'typescript', format: 'snippet', dataClass: 'synthetic', text: 'eval(value);' }) });
  expect(denied.status).toBe(403);
  await stack.database.admin.query('DELETE FROM itervane.project_members WHERE project_id=$1', [project.id]);
  await expect(page.getByTestId('rule-bounded-review-context')).toHaveCount(0);
  expect((await stack.database.admin.query('SELECT * FROM itervane.preaudits WHERE project_id=$1', [project.id])).rowCount).toBe(0);
});

test('a real added-line diff preaudit does not report removed text as analyzed code', async ({ page, stack }) => {
  const project = await seedProject(stack); await openPreaudit(page, stack, project);
  await page.getByLabel('Input format', { exact: true }).selectOption('unified_diff');
  await page.getByLabel('Supplied text', { exact: true }).fill('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-eval(old);\n+const value = 1;\n');
  await page.getByRole('button', { name: 'Record preaudit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Text preaudit report', exact: true })).toBeVisible();
  await expect(page.getByTestId('preaudit-observations')).toContainText('No text-pattern observations');
  await expect(page.getByTestId('preaudit-uncovered')).toContainText('Only added diff lines were checked.');
});

test('the narrow Chinese preaudit form enforces UTF-8 limits without submitting oversized text', async ({ page, stack }) => {
  const project = await seedProject(stack); await page.setViewportSize({ width: 390, height: 844 });
  let posts = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/v1/preaudits' && request.method() === 'POST') posts++; });
  await openPreaudit(page, stack, project, 'zh-CN');
  await page.getByLabel('提供的文本', { exact: true }).fill('界'.repeat(6000));
  await page.getByRole('button', { name: '记录预审', exact: true }).click();
  await expect(page.getByText('请填写非空纯文本，限制为 16 KiB、1000 行，不接受不支持的控制字符。', { exact: true })).toBeVisible();
  await language(page, 'en');
  await expect(page.getByLabel('Supplied text', { exact: true })).toHaveValue('界'.repeat(6000));
  await expect(page.getByText('Enter nonempty plain text within 16 KiB and 1000 lines; unsupported control characters are refused.', { exact: true })).toBeVisible();
  expect(posts).toBe(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('normal motion follows real task changes and remains quiet through polling and localization', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await observeMotion(page, stack.origin);
  const project = await seedProject(stack); const authorization = authorizationFrom(page); await login(page, stack);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  const task = await admit(stack, authorization(), project); await paused(stack, task.id);
  await page.goto(`${stack.origin}/#/tasks/${task.id}`);
  await expect(page.locator('.state-marker')).toHaveAttribute('data-state', 'waiting_input');
  await expect(page.locator('.event-list li').first()).toBeVisible();
  await expect.poll(() => page.locator('.heading-accent').evaluate(element => (element as HTMLElement).style.transform)).toBe('');
  expect((await motionProbe(page)).headings).toBeGreaterThan(0);
  expect((await motionProbe(page)).events).toBe(0);
  await page.getByRole('button', { name: 'Cancel task', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(page.locator('.state-marker')).toHaveAttribute('data-state', 'cancelled');
  await expect.poll(async () => (await motionProbe(page)).state).toBeGreaterThan(0);
  await expect.poll(async () => (await motionProbe(page)).events).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.state-marker, .event-index').evaluateAll(elements => elements.every(element => !(element as HTMLElement).style.transform))).toBe(true);
  const afterChange = await motionProbe(page);
  for (let poll = 0; poll < 2; poll++) await page.waitForResponse(response => new URL(response.url()).pathname === `/v1/tasks/${task.id}` && response.ok());
  expect(await motionProbe(page)).toEqual(afterChange);
  await language(page, 'zh-CN'); await expect(page.getByRole('heading', { name: '任务详情', exact: true })).toBeVisible();
  await expect(page.locator('.event-list li').first()).toBeVisible();
  expect(await motionProbe(page)).toEqual(afterChange);
  await captureWorkspace(page, '.reports/p1-ux/task-zh.png');
  await page.screenshot({ path: '.reports/p1-ux/workspace-preview.png' });
  await language(page, 'en'); await captureWorkspace(page, '.reports/p1-ux/task-en.png');
  await expectMotionCsp(page);
  const capability = await (await fetch(`${stack.origin}/v1/capabilities`, { headers: { Authorization: authorization() } })).json();
  expect(capability).toMatchObject({ stage: 'p1-e', sourceScanning: false, taskExecution: false, deployment: false, operations: false });
});

test('keyboard disclosure honors a live reduced-motion change without retaining the previous report view', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await observeMotion(page, stack.origin);
  const project = await seedProject(stack); await openPreaudit(page, stack, project, 'zh-CN');
  await page.getByLabel('提供的文本', { exact: true }).fill('eval(value);'); await page.getByRole('button', { name: '记录预审', exact: true }).click();
  await expect(page.getByRole('heading', { name: '文本预审报告', exact: true })).toBeVisible();
  const reportId = page.url().split('/').at(-1)!; const summary = page.locator('summary');
  await summary.focus(); await summary.press('Enter'); await expect(page.locator('details')).toHaveAttribute('open', '');
  await expect.poll(async () => (await motionProbe(page)).disclosures).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => page.locator('.disclosure-content').evaluate(element => (element as HTMLElement).style.transform)).toBe('');
  const reduced = await motionProbe(page);
  await summary.press('Enter'); await expect(page.locator('.disclosure-content')).toBeHidden();
  await summary.press('Enter'); await expect(page.locator('.disclosure-content')).toBeVisible(); await expect(summary).toBeFocused();
  expect((await motionProbe(page)).disclosures).toBe(reduced.disclosures); await expectMotionCsp(page);
  await captureWorkspace(page, '.reports/p1-ux/report-zh.png');
  await page.getByRole('link', { name: /返回规则与预审$/ }).click();
  await expect(page.getByRole('heading', { name: '规则与文本预审', exact: true })).toBeVisible();
  await expect(page.locator('details')).toHaveCount(0); await expect(page.getByText(reportId, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('提供的文本', { exact: true })).toBeEmpty();
});

test('normal-motion permission failure removes private rules without an exit layer or CSP relaxation', async ({ page, stack }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await observeMotion(page, stack.origin);
  const project = await seedProject(stack, true); await openPreaudit(page, stack, project, 'en', 'viewer');
  await expect(page.getByText('Read-only access', { exact: true })).toBeVisible();
  await stack.database.admin.query('DELETE FROM itervane.project_members WHERE project_id=$1', [project.id]);
  await page.getByRole('button', { name: 'Refresh rules and history', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByTestId('rule-bounded-review-context')).toHaveCount(0);
  await expect(page.getByLabel('Supplied text', { exact: true })).toHaveCount(0);
  expect((await motionProbe(page)).privateWithError).toBe(false); await expectMotionCsp(page);
});

for (const locale of ['en', 'zh-CN'] as const) test(`the refreshed workspace supports narrow layouts and keyboard navigation in ${locale}`, async ({ page, stack }) => {
  const zh = locale === 'zh-CN'; await page.emulateMedia({ reducedMotion: zh ? 'reduce' : 'no-preference' }); await observeMotion(page, stack.origin);
  const project = await seedProject(stack); await page.setViewportSize({ width: 375, height: 812 }); await login(page, stack, 'owner', locale);
  await page.getByRole('link', { name: project.title, exact: true }).click();
  await page.getByRole('button', { name: zh ? '发起前置检查' : 'Start preflight', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('link', { name: zh ? '规则与文本预审' : 'Rules and text preaudit', exact: true }).click();
  await expect(page.getByTestId('rule-bounded-review-context')).toBeVisible();
  const skip = page.getByRole('link', { name: zh ? '跳到主要内容' : 'Skip to content', exact: true }); await skip.focus(); await skip.press('Enter');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
  await page.keyboard.press('Tab');
  for (const width of [375, 768, 1365]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
  await captureWorkspace(page, `.reports/p1-ux/preaudit-${locale}.png`);
  await page.setViewportSize({ width: 375, height: 812 }); await captureWorkspace(page, `.reports/p1-ux/mobile-${locale}.png`);
  await expectMotionCsp(page);
  if (zh) expect(await motionProbe(page)).toMatchObject({ headings: 0, state: 0, events: 0, disclosures: 0 });
});

for (const locale of ['en', 'zh-CN'] as const) test(`real design Skill import, review and ordered activation in ${locale}`, async ({ page, stack }) => {
  const t = (key: UiKey) => ui(locale, key);
  const project = await seedProject(stack);
  const packageKey = `design-fixture-${randomUUID()}`;
  const heading = locale === 'en' ? 'Sample layout' : '样例布局';
  const material = '<design-fixture>Review keyboard focus.</design-fixture>';
  await page.setViewportSize({ width: 390, height: 850 });
  await login(page, stack, 'owner', locale);
  await page.getByRole('link', { name: t('ruleLibrary'), exact: true }).click();

  async function importVersion(version: string) {
    await page.getByRole('link', { name: t('importDesignSkill'), exact: true }).click();
    await page.getByLabel(t('packageKey'), { exact: true }).fill(packageKey);
    await page.getByLabel(t('version'), { exact: true }).fill(version);
    await page.getByLabel(t('packageSourceName'), { exact: true }).fill('Itervane test fixture');
    await page.getByLabel(t('packageLicense'), { exact: true }).fill('Apache-2.0');
    await page.getByLabel(t('packageTitleEn'), { exact: true }).fill(`Sample layout ${version}`);
    await page.getByLabel(t('packageTitleZh'), { exact: true }).fill(`样例布局 ${version}`);
    await page.getByLabel(t('packageDescriptionEn'), { exact: true }).fill('Focus guidelines.');
    await page.getByLabel(t('packageDescriptionZh'), { exact: true }).fill('焦点指引。');
    await page.getByLabel(t('packageScope'), { exact: true }).selectOption(project.id);
    await page.getByLabel(t('packageSkillFile'), { exact: true }).setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(material) });
    await page.getByLabel(t('packageAssets'), { exact: true }).setInputFiles({ name: 'tokens.json', mimeType: 'application/json', buffer: Buffer.from('{"focus":8}') });
    await page.getByRole('button', { name: t('saveRuleDraft'), exact: true }).click();
    await expect(page.getByRole('heading', { name: `${heading} ${version}`, exact: true })).toBeVisible();
    return new URL(page.url()).hash;
  }

  async function review() {
    for (const key of ['packageReviewSource', 'packageReviewScope', 'packageReviewResources'] as const) {
      await page.getByRole('checkbox', { name: t(key), exact: true }).check();
    }
    await page.getByRole('button', { name: t('savePackageReview'), exact: true }).click();
    await expect(page.getByRole('button', { name: t('packagePublish'), exact: true })).toBeVisible();
  }

  async function activate(key: 'packagePublish' | 'packageRollback' | 'packageWithdraw', retry = false) {
    await page.getByRole('button', { name: t(key), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: t('packageConfirmActivation') })).toBeVisible();
    await expect(dialog.getByRole('button', { name: t('cancel'), exact: true })).toBeFocused();
    await dialog.getByRole('button', { name: t(key), exact: true }).click();
    if (retry) await dialog.getByRole('button', { name: t('retrySubmission'), exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }

  const original = await importVersion('1.0.0');
  const disclosure = page.locator('summary').getByText('SKILL.md', { exact: true });
  await disclosure.focus(); await disclosure.press('Enter');
  await expect(page.getByText(material, { exact: true })).toBeVisible();
  await expect(page.locator('design-fixture')).toHaveCount(0);
  await review();
  const requests: string[] = [];
  if (locale === 'en') await page.route('**/v1/rule-packages/*/activation', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(route.request().postDataJSON().idempotencyKey);
    if (requests.length !== 1) return route.continue();
    expect((await route.fetch()).status()).toBe(201);
    await route.abort();
  });
  await activate('packagePublish', locale === 'en');
  if (locale === 'en') expect(requests).toEqual([requests[0], requests[0]]);
  await expect(page.getByRole('button', { name: t('packageWithdraw'), exact: true })).toBeVisible();
  await page.locator('aside').getByRole('link', { name: t('ruleLibrary'), exact: true }).click();
  await importVersion('1.1.0');
  await review(); await activate('packagePublish');
  await expect(page.getByRole('button', { name: t('packageWithdraw'), exact: true })).toBeVisible();
  await page.evaluate(hash => { location.hash = hash; }, original);
  await activate('packageRollback');
  await expect(page.getByRole('button', { name: t('packageWithdraw'), exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await activate('packageWithdraw');
  await expect(page.getByText(t('packageInactive'), { exact: true })).toBeVisible();

  const { rows } = await stack.database.admin.query(`SELECT activation.action, version.version
    FROM itervane.rule_package_activations activation JOIN itervane.rule_package_versions version ON version.id=activation.version_id
    WHERE version.package_key=$1 ORDER BY activation.sequence`, [packageKey]);
  expect(rows).toEqual([{ action: 'publish', version: '1.0.0' }, { action: 'publish', version: '1.1.0' },
    { action: 'rollback', version: '1.0.0' }, { action: 'withdraw', version: '1.0.0' }]);
  if (locale === 'zh-CN') {
    const [grant] = (await stack.database.admin.query('DELETE FROM itervane.workspace_members RETURNING workspace_id, principal_id, grant_id')).rows;
    try {
      await expect(page.getByRole('heading', { name: t('accessDenied'), exact: true })).toBeVisible();
      await expect(page.getByText('SKILL.md', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: t('packagePublish'), exact: true })).toHaveCount(0);
    } finally {
      await stack.database.admin.query('INSERT INTO itervane.workspace_members(workspace_id,principal_id,grant_id) VALUES ($1,$2,$3)',
        [grant.workspace_id, grant.principal_id, grant.grant_id]);
    }
  }
});
