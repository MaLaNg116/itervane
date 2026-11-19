import { evaluationSchema, preauditInputSchema, preauditRecordSchema, type Evaluation, type PreauditInput } from '@itervane/contracts';
import { catalogSnapshot, digest } from './catalog.js';
import { inputLines, selectText } from './text.js';

export class RuleCatalogMismatch extends Error { constructor() { super('rule_catalog_changed'); } }
export function inputHash(input: PreauditInput) {
  return digest(JSON.stringify(preauditInputSchema.parse(input)));
}
export function recordHash(value: unknown) { return digest(JSON.stringify(preauditRecordSchema.parse(value))); }

export function evaluateText(raw: unknown): Evaluation {
  const input = preauditInputSchema.parse(raw); const catalog = catalogSnapshot();
  if (input.catalogSha256 !== catalog.sha256) throw new RuleCatalogMismatch();
  const selected = selectText(input.text, input.format);
  const eligible = catalog.rules.filter(rule => rule.material.detector !== 'none' && rule.material.languages.includes(input.language));
  const observations: Evaluation['observations'] = []; let limited = false; let analyzedLines = 0;
  outer: for (const line of selected) {
    analyzedLines++;
    for (const rule of eligible) {
      // Fixed, bounded text patterns only. Caller-controlled code, regex and instructions are never executed.
      const detector = rule.material.detector;
      const hit = detector === 'eval-call' ? /\beval[ \t]*\(/.test(line.text)
        : detector === 'html-sink' ? /\b(?:innerHTML|dangerouslySetInnerHTML)\b/.test(line.text)
        : detector === 'allow-marker' && line.text.includes('gitleaks:allow');
      if (!hit) continue;
      if (observations.length === 100) { limited = true; break outer; }
      observations.push({ ruleId: rule.material.id, certainty: detector === 'allow-marker' ? 'observed_text' : 'suspected', inputLine: line.inputLine, sourceLine: line.sourceLine });
    }
  }
  const uncovered: Evaluation['uncovered'] = ['repository_context', 'formal_scanners', 'runtime_behavior', 'semantic_analysis'];
  if (input.format === 'unified_diff') { uncovered.push('unchanged_lines'); if (!selected.length) uncovered.push('no_added_lines'); }
  if (limited) uncovered.push('observation_limit');
  return evaluationSchema.parse({ version: 1, input: { origin: 'client_supplied', sha256: digest(input.text), language: input.language, format: input.format,
    dataClass: input.dataClass, bytes: new TextEncoder().encode(input.text).byteLength, lines: inputLines(input.text).length, analyzedLines }, catalog,
    outcome: observations.length ? 'observations' : eligible.length && selected.length ? 'no_observations' : 'not_analyzed', observations,
    coverage: catalog.rules.map(rule => ({ ruleId: rule.material.id, status: !rule.material.languages.includes(input.language) ? 'not_applicable'
      : rule.material.detector === 'none' ? 'guidance_only' : !selected.length ? 'not_analyzed' : limited ? 'partial' : 'checked' })),
    uncovered, formalScan: false, releaseEligible: false });
}
