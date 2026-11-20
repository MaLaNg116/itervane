import { checkKinds, type AgentEvidence, type DeliveryRole } from '@itervane/agent';
import type { Locale } from '@itervane/contracts';
import type { ModelAdapter } from '@itervane/model';

type Context = {
  role: DeliveryRole;
  handoff: { findings: { id: string }[]; previousChecks?: { status: string }[] };
  observations: AgentEvidence[];
};

export function scriptedModel(locale: Locale, options: { tryBroadTemplate?: boolean } = {}): ModelAdapter {
  const summary = locale === 'zh-CN' ? '根据当前可信样例回执得出结论。' : 'Conclusion based on the current fixture receipts.';
  return {
    protocol: 'anthropic',
    async complete({ conversation }) {
      const message = conversation[0];
      if (message?.kind !== 'user') throw new Error('Expected structured observations');
      const { role, handoff, observations } = JSON.parse(message.text) as Context;
      const choose = (name: string, input: unknown) => ({
        text: '', calls: [{ id: 'fixture-native-call', name, input }], tokenUsage: 1,
      });
      const evidenceIds = observations.map(item => item.id);
      if (role === 'audit') {
        const overview = observations.find(item => item.data.kind === 'context' && item.data.section === 'overview');
        if (!overview || overview.data.kind !== 'context') return choose('read_context', { section: 'overview' });
        const { suggestedSection: section } = overview.data;
        if (section !== 'display' && section !== 'pagination') return choose('request_human', {});
        if (!observations.some(item => item.data.kind === 'context' && item.data.section === section)) return choose('read_context', { section });
        if (!observations.some(item => item.data.kind === 'rule')) return choose('read_rule', { ruleId: 'bounded-review-context' });
        const report = observations.find(item => item.data.kind === 'findings');
        if (!report || report.data.kind !== 'findings') return choose('read_findings', {});
        return choose('finish_role', {
          summary, evidenceIds, hypotheses: [],
          explanations: report.data.findings.map(finding => ({
            findingId: finding.id, impact: finding.title,
            suggestion: locale === 'zh-CN' ? '修正对应设置并完成复验。' : 'Correct the matching setting and verify the candidate.',
          })),
        });
      }
      if (role === 'repair') {
        if (!observations.some(item => item.data.kind === 'context')) return choose('read_context', { section: 'overview' });
        if (!observations.some(item => item.data.kind === 'candidate')) {
          const chooseBroad = options.tryBroadTemplate && !handoff.previousChecks;
          const templateIds = handoff.findings.map(finding => finding.id === 'empty_message'
            ? (chooseBroad ? 'normalize_display' : 'fill_empty_message') : 'default_page_size');
          return choose('draft_repair', { templateIds });
        }
        return choose('finish_role', { summary, evidenceIds });
      }
      if (!observations.some(item => item.data.kind === 'candidate')) return choose('read_candidate', {});
      const check = checkKinds.find(kind => !observations.some(item => item.data.kind === 'check' && item.data.result.check === kind));
      return check ? choose('check_candidate', { check }) : choose('finish_role', { summary, evidenceIds });
    },
  };
}
