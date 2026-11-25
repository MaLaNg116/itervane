import type { CodeRuleValidationProfile, PublishedCodeRuleSet } from '@itervane/contracts';
import type { Transaction } from './access.js';
import { readPinnedValidatedRules } from './task-published-rule-versions.js';
import { readTaskRuleSnapshot } from './task-rule-snapshots.js';

/** Loads the past activation rows named by the task, including versions subsequently rolled back. */
export async function readTaskPublishedCodeRules(tx: Transaction, task: { id: string; projectId: string },
  profile?: CodeRuleValidationProfile): Promise<PublishedCodeRuleSet | null> {
  const pinned = await readTaskRuleSnapshot(tx, task);
  if (!pinned || pinned.document.purpose !== 'delivery') return null;
  const entries = pinned.document.entries.filter(entry => entry.kind === 'code_rule');
  if (!entries.length) return null;
  if (!profile) throw new Error('published_inspection_profile_unavailable');
  const resolved = await readPinnedValidatedRules(tx, task, entries);
  const rules = resolved.map(({ document, review, record }) => {
    if (document.kind !== 'code_rule') throw new Error('task_published_code_scope');
    return { package: document, review, validation: record };
  });
  return { version: 1, snapshot: { sha256: pinned.sha256, document: pinned.document }, profile, rules };
}
