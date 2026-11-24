import { z } from 'zod';
import { localeSchema } from './i18n.js';
import { sha256Schema } from './inspection.js';
import { idSchema } from './primitives.js';
import { limitedTextSchema, ruleIdSchema } from './preaudit.js';
import { listQuerySchema } from './control-plane.js';

const versionLabel = z.string().max(32).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const pathSegment = '[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}';
const referencePath = new RegExp('^references/(?:' + pathSegment + '/){0,3}' + pathSegment + '\\.md$');
const designAssetPath = new RegExp('^assets/(?:' + pathSegment + '/){0,3}' + pathSegment + '\\.json$');
const skillText = limitedTextSchema.transform(value => value.replace(/\r\n/g, '\n'));
const plainLabel = limitedTextSchema.pipe(z.string().trim().min(1).max(160).refine(value => !/[\r\n\t]/.test(value)));
const summary = z.strictObject({ title: plainLabel, description: skillText.pipe(z.string().trim().max(1_200)) });
const sourceUrl = z.string().max(2_048).refine(value => {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});
const source = z.strictObject({
  name: plainLabel,
  license: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/),
  url: sourceUrl.optional(),
});
const scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace') }),
  z.strictObject({ kind: z.literal('project'), projectId: idSchema }),
]);
const resource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('reference'), path: z.string().max(160).regex(referencePath), locale: localeSchema, content: skillText }),
  z.strictObject({ kind: z.literal('design_data'), path: z.string().max(160).regex(designAssetPath), content: skillText.refine(value => {
    try {
      const data: unknown = JSON.parse(value);
      return data !== null && typeof data === 'object' && !Array.isArray(data);
    } catch { return false; }
  }) }),
]);

export const designSkillPackageSchema = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('design_skill'),
  packageKey: ruleIdSchema,
  version: versionLabel,
  scope,
  source,
  text: z.strictObject({ en: summary, 'zh-CN': summary }),
  skill: z.strictObject({ path: z.literal('SKILL.md'), locale: localeSchema, content: skillText }),
  resources: z.array(resource).max(8).default([]).refine(items =>
    new Set(items.map(item => item.path.toLowerCase())).size === items.length).transform(items =>
    [...items].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
}).refine(document => new TextEncoder().encode(JSON.stringify(document)).length <= 48 * 1024, 'Rule package exceeds 48 KiB');
export type DesignSkillPackage = z.infer<typeof designSkillPackageSchema>;

export const rulePackageRevisionSchema = z.strictObject({
  packageId: idSchema, versionId: idSchema, packageKey: ruleIdSchema, version: versionLabel, sha256: sha256Schema,
  scope, source, text: summary, locale: localeSchema, kind: z.literal('design_skill'),
  reviewState: z.literal('draft'), reviewMessage: z.string(), createdAt: z.iso.datetime(),
});
export const rulePackageDetailSchema = rulePackageRevisionSchema.extend({ document: designSkillPackageSchema });
export const rulePackageImportResultSchema = z.strictObject({ version: rulePackageDetailSchema, replayed: z.boolean() });
export const rulePackageListQuerySchema = listQuerySchema.extend({ before: idSchema.optional() });
export const rulePackagePageSchema = z.strictObject({ items: z.array(rulePackageRevisionSchema).max(100), nextBefore: idSchema.nullable() });
