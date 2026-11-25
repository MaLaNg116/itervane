import { formalAuditDesignGuidanceSchema, type Locale } from '@itervane/contracts';
import type { Transaction } from './access.js';
import { readPinnedRuleVersions } from './task-published-rule-versions.js';
import type { readTaskRuleSnapshot } from './task-rule-snapshots.js';

export async function readAuditDesignGuidance(tx: Transaction, task: { projectId: string; locale: Locale },
  pinned: Awaited<ReturnType<typeof readTaskRuleSnapshot>>) {
  if (!pinned || pinned.document.purpose !== 'delivery') return;
  const references = pinned.document.entries.filter(entry => entry.kind === 'design_skill');
  if (!references.length) return;
  const entries = (await readPinnedRuleVersions(tx, task, references)).map(({ entry, document }) => {
    if (document.kind !== 'design_skill') throw new Error('audit_design_guidance_kind');
    const { title, description } = document.text[task.locale];
    // Leave room for the maximum number of references and the bundled catalog in the stored audit input.
    const summary = (description || title).slice(0, 160).toWellFormed().trim();
    const excerpt = document.skill.locale === task.locale ? document.skill.content.slice(0, 160).toWellFormed().trim() : '';
    const ruleId = `skill-${entry.packageKey.slice(0, 20)}-${entry.versionId.replaceAll('-', '')}`;
    return { ruleId, reference: entry, version: document.version, guidance: excerpt ? summary + '\n' + excerpt : summary };
  });
  return formalAuditDesignGuidanceSchema.parse({ snapshotSha256: pinned.sha256, entries });
}
