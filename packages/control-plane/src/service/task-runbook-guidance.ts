import { operationsRunbookGuidanceSchema } from '@itervane/contracts';
import { evaluateRunbookSamples, selectRunbookAction } from '@itervane/rules';
import type { Transaction } from './access.js';
import { readPinnedValidatedRules } from './task-published-rule-versions.js';
import { readTaskRuleSnapshot } from './task-rule-snapshots.js';

export async function readTaskRunbookGuidance(tx: Transaction, task: { id: string; projectId: string }) {
  const pinned = await readTaskRuleSnapshot(tx, task);
  if (!pinned || !pinned.document.entries.length) return;
  if (pinned.document.purpose !== 'operations') throw new Error('task_runbook_purpose');

  const resolved = await readPinnedValidatedRules(tx, task, pinned.document.entries);
  const runbooks = resolved.map(({ entry, document, record }) => {
    if (document.kind !== 'runbook' || record.evidence.kind !== 'runbook') throw new Error('task_runbook_binding');
    const evaluated = evaluateRunbookSamples(document.candidate);
    if (evaluated.status !== 'passed' || JSON.stringify(evaluated) !== JSON.stringify(record.evidence.result)) {
      throw new Error('task_runbook_validation');
    }
    return { entry, document };
  });

  const choose = (observedState: 'exited' | 'dead') => {
    const matches = runbooks.filter(({ document }) => selectRunbookAction(document.candidate, {
      observedState, publication: 'current', approvals: 'missing', priorAttempts: 0,
    }) === 'await_approval');
    if (!matches.length) return { status: 'no_match' };
    if (matches.length !== 1) return { status: 'ambiguous' };
    const { entry, document } = matches[0]!;
    const { action, controls, success } = document.candidate;
    return { status: 'available', rule: entry, version: document.version, validationSha256: document.validation.sha256, action, controls, success };
  };
  return operationsRunbookGuidanceSchema.parse({ version: 1, snapshotSha256: pinned.sha256,
    byState: { exited: choose('exited'), dead: choose('dead') } });
}
