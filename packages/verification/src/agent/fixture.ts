import { randomUUID } from 'node:crypto';
import {
  agentSpecSchema, sha256, type AgentFixtureHost, type AgentScope, type AgentSpec,
  type Candidate, type EvidenceData, type ProtectedCheck,
} from '@itervane/agent';
import type { Locale } from '@itervane/contracts';
import { catalogSnapshot, ruleView } from '@itervane/rules';

type Settings = { emptyMessage: string; pageSize: number; statusLabel: string };
export const deliveryCases = ['display', 'pagination'] as const;
type DeliveryCase = typeof deliveryCases[number];
const fixtures: Record<DeliveryCase, Settings> = {
  display: { emptyMessage: '', pageSize: 20, statusLabel: 'Ready' },
  pagination: { emptyMessage: 'No items', pageSize: 0, statusLabel: 'Ready' },
};
const serialize = (settings: Settings) => JSON.stringify(settings, null, 2) + '\n';
const baselineVersion = 'settings-fixture-v1:empty-message,page-size,preserve-status-label';
const ruleId = 'bounded-review-context';
const impacts = {
  en: {
    sections: { display: 'Display settings', pagination: 'Pagination settings' },
    empty_message: 'The empty page has no guidance for readers.',
    page_size: 'A zero page size hides existing items.',
  },
  'zh-CN': {
    sections: { display: '显示配置', pagination: '分页配置' },
    empty_message: '空页面缺少给读者的提示。',
    page_size: '分页大小为零会隐藏已有条目。',
  },
};
const templates = {
  fill_empty_message: { finding: 'empty_message', apply: (settings: Settings) => { settings.emptyMessage = 'No items'; } },
  default_page_size: { finding: 'page_size', apply: (settings: Settings) => { settings.pageSize = 20; } },
  normalize_display: { finding: 'empty_message', apply: (settings: Settings) => {
    settings.emptyMessage = 'No items';
    settings.statusLabel = 'OK';
  } },
};
type TemplateId = keyof typeof templates;

function inspect(settings: Settings, locale: Locale) {
  const finding = (id: 'empty_message' | 'page_size', location: string) => ({
    id, ruleId: id, severity: 'low' as const, certainty: 'confirmed' as const,
    title: impacts[locale][id], location: `settings.json:${location}`,
  });
  return [
    ...(!settings.emptyMessage.trim() ? [finding('empty_message', 'emptyMessage')] : []),
    ...(!(Number.isInteger(settings.pageSize) && settings.pageSize > 0) ? [finding('page_size', 'pageSize')] : []),
  ];
}

function materialize(original: Settings, ids: string[]) {
  const next = { ...original };
  const findingIds = new Set<string>();
  for (const id of ids) {
    if (!Object.hasOwn(templates, id)) return;
    const template = templates[id as TemplateId];
    if (findingIds.has(template.finding)) return;
    template.apply(next);
    findingIds.add(template.finding);
  }
  const before = serialize(original);
  const bytes = serialize(next);
  if (bytes === before) return;
  const from = before.trimEnd().split('\n');
  const to = bytes.trimEnd().split('\n');
  const lines = from.flatMap((line, index) => line === to[index] ? [` ${line}`] : [`-${line}`, `+${to[index]}`]);
  const diff = ['--- a/settings.json', '+++ b/settings.json', `@@ -1,${from.length} +1,${to.length} @@`, ...lines, ''].join('\n');
  return {
    bytes,
    candidate: {
      baseSha256: sha256(before), snapshotSha256: sha256(bytes), diffSha256: sha256(diff), diff,
      templateIds: ids, findingIds: [...findingIds],
    } satisfies Candidate,
  };
}

function protectedCheck(check: ProtectedCheck['check'], bytes: string, original: Settings, locale: Locale): EvidenceData {
  const value = JSON.parse(bytes) as Settings;
  const failing = check === 'rescan' ? inspect(value, locale).map(finding => finding.id)
    : check === 'baseline' ? (value.statusLabel === original.statusLabel ? [] : ['status_label_changed'])
    : [
      ...(original.emptyMessage || value.emptyMessage === 'No items' ? [] : ['empty_message']),
      ...(original.pageSize > 0 || value.pageSize === 20 ? [] : ['page_size']),
    ];
  return { kind: 'check', result: { check, status: failing.length ? 'failed' : 'passed', findingIds: failing } };
}

function sections(original: Settings, locale: Locale) {
  const section = !original.emptyMessage ? 'display' : 'pagination';
  const overview = locale === 'zh-CN'
    ? `优先检查区段 ${section}。可查询审阅指导 ${ruleId}。模板 fill_empty_message 修正空提示，default_page_size 修正页大小。normalize_display 也会改状态标签。基线要求保留状态标签。`
    : `Inspect the ${section} section first. Review guidance ${ruleId} is available. Templates: fill_empty_message for emptyMessage, default_page_size for pageSize. normalize_display also resets statusLabel. The baseline preserves statusLabel.`;
  return { section, notes: {
    overview,
    display: `${impacts[locale].sections.display}: ${JSON.stringify({ emptyMessage: original.emptyMessage, statusLabel: original.statusLabel })}`,
    pagination: `${impacts[locale].sections.pagination}: ${JSON.stringify({ pageSize: original.pageSize })}`,
  } } as const;
}

export function createDeliveryFixture(name: DeliveryCase, locale: Locale, limits?: Partial<AgentSpec['limits']>) {
  const original = fixtures[name];
  const source = serialize(original);
  const catalog = catalogSnapshot();
  const spec = agentSpecSchema.parse({
    taskId: randomUUID(), runId: randomUUID(), projectId: randomUUID(), generation: 1,
    source: { repositoryId: randomUUID(), commit: sha256(`synthetic:${source}`) },
    snapshotSha256: sha256(source), catalogSha256: catalog.sha256, baselineSha256: sha256(baselineVersion), locale,
    goal: locale === 'zh-CN' ? '审计固定设置样例，修复明确问题并完成独立复验。先通过 overview 了解设置。'
      : 'Audit the fixed settings fixture, repair confirmed findings, and obtain independent verification. Read overview for orientation.',
    limits: { maxTurns: 24, maxToolCalls: 17, maxTokens: 60_000, maxContextBytes: 12_288,
      maxDurationMs: 120_000, maxStalledTurns: 3, maxRepairs: 2, ...limits },
  });
  const bindingSha256 = sha256(JSON.stringify(spec));
  const { notes, section } = sections(original, locale);
  const allowed = (scope: AgentScope, signal: AbortSignal) => !signal.aborted
    && scope.bindingSha256 === bindingSha256 && sha256(JSON.stringify(scope.spec)) === bindingSha256
    && (scope.role === 'verify' || scope.snapshotSha256 === spec.snapshotSha256);
  const host: AgentFixtureHost = {
    async authorize(scope, signal) { return allowed(scope, signal); },
    async observe({ scope, call, candidate, audit, signal }) {
      if (!allowed(scope, signal)) return;
      let data: EvidenceData | undefined;
      switch (call.name) {
        case 'read_context':
          data = { kind: 'context', section: call.args.section, text: notes[call.args.section],
            ...(call.args.section === 'overview' ? { suggestedSection: section } : {}),
          };
          break;
        case 'read_rule': {
          const snapshot = catalog.rules.find(item => item.material.id === call.args.ruleId);
          if (!snapshot) return;
          const view = ruleView(snapshot, locale);
          data = { kind: 'rule', ruleId: view.id, sha256: view.sha256, guidance: view.guidance, limitation: view.limitation };
          break;
        }
        case 'read_findings':
          data = { kind: 'findings', coverage: 'complete', limits: [], findings: inspect(JSON.parse(source) as Settings, locale) };
          break;
        case 'draft_repair': {
          const result = materialize(original, call.args.templateIds);
          if (!result || !audit || !result.candidate.findingIds.every(id => audit.findings.some(finding => finding.id === id))) return;
          data = { kind: 'candidate', candidate: result.candidate };
          break;
        }
        case 'read_candidate':
        case 'check_candidate': {
          if (!candidate) return;
          const normalized = materialize(original, candidate.templateIds);
          if (!normalized || scope.snapshotSha256 !== normalized.candidate.snapshotSha256
            || JSON.stringify(candidate) !== JSON.stringify(normalized.candidate)) return;
          data = call.name === 'read_candidate'
            ? { kind: 'candidate', candidate }
            : protectedCheck(call.args.check, normalized.bytes, original, locale);
          break;
        }
      }
      return { origin: 'trusted_fixture', bindingSha256, snapshotSha256: scope.snapshotSha256, data };
    },
  };
  return { spec, host };
}
