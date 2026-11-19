import { expect, it } from 'vitest';
import { preauditInputSchema, ruleMaterialSchema } from '@itervane/contracts';
import { catalogSnapshot, ruleView, validCatalog } from '../../src/catalog.js';
import { randomUUID } from 'node:crypto';

it('provides checks, guidance and a Skill with stable bilingual content and an advisory-only fingerprint', () => {
  const catalog = catalogSnapshot(); expect(validCatalog(catalog)).toBe(true);
  expect(catalog.rules.map(rule => rule.material.kind)).toEqual(['check', 'check', 'check', 'guidance', 'skill']);
  for (const rule of catalog.rules) {
    const en = ruleView(rule, 'en'); const zh = ruleView(rule, 'zh-CN');
    expect(en.sha256).toBe(zh.sha256); expect(en.title).not.toBe(zh.title); expect(en.enforcement).toBe('advisory');
    expect(en).not.toHaveProperty('detector'); expect(en.source.kind).toBe('bundled');
  }
});
it('does not mutate bundled rules when a caller changes its copy or silently accept content with an old digest', () => {
  const changed = catalogSnapshot(); changed.rules[0]!.material.text.en.title = 'Modified';
  expect(validCatalog(changed)).toBe(false); expect(validCatalog(catalogSnapshot())).toBe(true);
  expect(ruleMaterialSchema.safeParse({ ...changed.rules[0]!.material, enforcement: 'approved' }).success).toBe(false);
});
it('enforces byte, line, encoding and strict input boundaries without accepting executable extensions', () => {
  const base = { projectId: randomUUID(), idempotencyKey: randomUUID(), catalogSha256: catalogSnapshot().sha256,
    language: 'typescript', format: 'snippet', dataClass: 'synthetic', text: 'const n = 1;' };
  expect(preauditInputSchema.safeParse(base).success).toBe(true);
  for (const text of ['x'.repeat(16385), '界'.repeat(6000), Array(1001).fill('x').join('\n'), 'x\u0000y', '\ud800', 'x\ry']) {
    expect(preauditInputSchema.safeParse({ ...base, text }).success).toBe(false);
  }
  for (const extra of [{ regex: '.*' }, { script: 'ignored' }, { approved: true }, { url: 'https://example.invalid' }]) {
    expect(preauditInputSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  }
});
