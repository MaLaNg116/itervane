import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Check } from '@itervane/contracts';
import { report } from './report.js';

const execute = promisify(execFile);
const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('baseline') }).strict(),
  z.object({ kind: z.literal('source-edit'), edits: z.array(z.object({
    file: z.string().regex(/^(server|src)\/[a-zA-Z0-9_.-]+\.(mjs|jsx|css)$|^index\.html$/),
    find: z.string().min(1), replace: z.string(),
  }).strict()).min(1) }).strict(),
  z.object({ kind: z.literal('environment'), values: z.object({
    ITERVANE_FIXTURE_MODE: z.enum(['healthy', 'unhealthy', 'startup-failure']).optional(),
    ITERVANE_FIXTURE_VERSION: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/).optional(),
  }).strict().refine(value => Object.values(value).some(item => item !== undefined), 'An environment input must set a value') }).strict(),
  z.object({ kind: z.literal('scenario'), events: z.array(z.object({ action: z.string().min(1), data: z.record(z.string(), z.json()) }).strict()).min(1) }).strict(),
]);

export const inventorySchema = z.object({
  version: z.literal(1), fixture: z.literal('fixtures/standard-app'),
  cases: z.array(z.object({
    id: z.string().regex(/^[DOGK]\d{2}$/),
    loop: z.enum(['delivery', 'operations', 'governance', 'knowledge']),
    split: z.enum(['development', 'holdout']), phase: z.enum(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']),
    category: z.enum(['normal', 'repair', 'regression', 'adversarial', 'failure', 'recovery']),
    title: z.string().min(1), input: inputSchema,
    expected: z.enum(['completed', 'blocked', 'needs_human', 'reconciled', 'cancelled', 'rejected', 'reuse_verified']),
    oracles: z.array(z.string().min(1)).min(1), control: z.string().min(1).optional(),
  }).strict()).min(20).max(30),
}).strict().superRefine((value, context) => {
  if (new Set(value.cases.map(c => c.id)).size !== value.cases.length) context.addIssue({ code: 'custom', message: 'Duplicate case IDs' });
  if (new Set(value.cases.map(c => c.loop)).size !== 4) context.addIssue({ code: 'custom', message: 'Missing loop coverage' });
  if (value.cases.filter(c => c.split === 'holdout').length < 4) context.addIssue({ code: 'custom', message: 'Holdout cases required' });
  if (!value.cases.some(c => c.control)) context.addIssue({ code: 'custom', message: 'Deterministic comparison required' });
});

export async function validateInventory(value: unknown, readFixture: (file: string) => Promise<string>) {
  const inventory = inventorySchema.parse(value);
  for (const entry of inventory.cases) {
    if (entry.input.kind !== 'source-edit') continue;
    const mutations = new Map<string, string>();
    for (const edit of entry.input.edits) {
      const source = mutations.get(edit.file) ?? await readFixture(edit.file);
      if (source.split(edit.find).length !== 2 || edit.find === edit.replace) throw new Error(`Stale or ambiguous fixture edit: ${entry.id}`);
      mutations.set(edit.file, source.replace(edit.find, edit.replace));
    }
  }
  return inventory;
}

export async function probeEvaluation() {
  const fixture = resolve('fixtures/standard-app');
  const inventory = await validateInventory(JSON.parse(await readFile('evaluation/cases.json', 'utf8')),
    file => readFile(resolve(fixture, file), 'utf8'));
  const checks: Check[] = [{ id: 'prepared-inventory', status: 'passed',
    detail: `${inventory.cases.length} cases prepared, including ${inventory.cases.filter(c => c.split === 'holdout').length} holdouts; inputs and source edits validated. Future platform cases have NOT been executed.` }];
  try {
    await execute(process.execPath, [resolve(fixture, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: fixture, timeout: 30_000, maxBuffer: 128 * 1024 });
    checks.push({ id: 'trusted-fixture-build', status: 'passed', detail: 'Trusted reference React/Vite application built locally; no image or VM deployment claim.' });
  } catch {
    checks.push({ id: 'trusted-fixture-build', status: 'failed', detail: 'Reference build failed; install the locked dependencies first.' });
    return report('evaluation', checks);
  }
  try {
    await execute(process.execPath, ['--test', 'test/application.test.mjs'], { cwd: fixture, timeout: 30_000, maxBuffer: 128 * 1024 });
    checks.push({ id: 'trusted-fixture-http', status: 'passed', detail: 'Five real HTTP/startup/asset checks passed against the trusted baseline; mutated cases require the future VM Runner.' });
  } catch {
    checks.push({ id: 'trusted-fixture-http', status: 'failed', detail: 'Reference application tests failed; inspect pnpm --filter @itervane/standard-app test locally.' });
  }
  return report('evaluation', checks);
}
