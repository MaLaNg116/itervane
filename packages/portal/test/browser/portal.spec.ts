import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test as base, expect, type Page } from '@playwright/test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { admissionDtoSchema, catalogDtoSchema, formalAuditDtoSchema, formalReleaseCandidateDtoSchema, formalReleaseDecisionResultSchema,
  formalReleaseViewSchema, formalRepairDtoSchema, formalRepairPatchDtoSchema, preauditDtoSchema, releaseDecisionInputSchema,
  sourceInspectionDtoSchema, taskDtoSchema, translate, verificationViewSchema, type FormalReleaseCandidateDto, type TaskDto } from '@itervane/contracts';
import { browserStack } from './stack.js';

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
      candidate: current ? localize(current, locale) : null, candidateTarget: current ? target : null,
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
    taskId: task.id, runId: task.runId, taskVersion: task.version, candidate, candidateTarget: target, availableTargets: [], actions: [],
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
