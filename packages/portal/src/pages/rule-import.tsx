import { useMutation } from '@tanstack/react-query';
import { designSkillPackageSchema, projectDtoSchema, rulePackageImportResultSchema } from '@itervane/contracts';
import { z } from 'zod';
import { ApiFailure } from '../api.js';
import { Failure, Loading, PageHeading, Panel } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { FormField } from '../forms.js';
import { navigate } from '../router.js';
import { Button } from '../ui/button.js';
import { Input, NativeSelect } from '../ui/fields.js';
import { readPackageMetadata, RulePackageFields } from './rule-package-fields.js';

const projectList = z.strictObject({ items: projectDtoSchema.array() });
const selectedFiles = (form: FormData, field: string) => form.getAll(field).filter((file): file is File => file instanceof File && file.name !== '');

async function readDesignFiles(form: FormData) {
  const [skill] = selectedFiles(form, 'skill');
  const references = selectedFiles(form, 'references');
  const assets = selectedFiles(form, 'assets');
  const files = [...references, ...assets];
  if (!skill || skill.name !== 'SKILL.md' || files.length > 8 || [skill, ...files].some(file => file.size > 16 * 1024)
      || [skill, ...files].reduce((sum, file) => sum + file.size, 0) > 48 * 1024) throw new ApiFailure('invalidRulePackage');
  const locale = form.get('fileLocale');
  const read = async (file: File) => new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  try {
    return { skill: { path: 'SKILL.md', locale, content: await read(skill) }, resources: await Promise.all([
      ...references.map(async file => ({ kind: 'reference', path: `references/${file.name}`, locale, content: await read(file) })),
      ...assets.map(async file => ({ kind: 'design_data', path: `assets/${file.name}`, content: await read(file) })),
    ]) };
  } catch {
    throw new ApiFailure('invalidRulePackage');
  }
}

export function RuleImportPage() {
  const { api, locale } = usePortal();
  const t = useText();
  const projects = useRemote('/v1/projects?limit=100', projectList);
  const submit = useMutation({ retry: false, gcTime: 0, mutationFn: async (values: FormData) => {
    const scope = values.get('scope');
    const draft = designSkillPackageSchema.safeParse({ formatVersion: 1, kind: 'design_skill', ...readPackageMetadata(values),
      scope: scope === 'workspace' ? { kind: 'workspace' } : { kind: 'project', projectId: scope }, ...await readDesignFiles(values) });
    if (!draft.success) throw new ApiFailure('invalidRulePackage');
    return api.request('/v1/rule-packages', rulePackageImportResultSchema, locale, { method: 'POST', body: draft.data });
  }, onSuccess: ({ version }) => navigate(`#/rule-packages/${version.packageId}/versions/${version.versionId}`) });
  if (projects.isPending) return <Loading locale={locale} />;
  if (projects.error) return <Failure error={projects.error} locale={locale} retry={() => { void projects.refetch(); }} />;
  return <>
    <a href="#/rule-packages" className="back-link">← {t('ruleLibrary')}</a>
    <PageHeading title={t('importDesignSkill')} />
    <Panel title={t('packageVersion')}>
      <form className="form-stack" aria-busy={submit.isPending} onSubmit={event => {
        event.preventDefault();
        if (!submit.isPending) submit.mutate(new FormData(event.currentTarget));
      }}>
        <fieldset className="form-stack" disabled={submit.isPending}>
          <RulePackageFields />
          <FormField label={t('packageScope')}>{props => <NativeSelect {...props} name="scope" required defaultValue="">
            <option value="" disabled>{t('packageChooseScope')}</option>
            {projects.data.items.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
            <option value="workspace">{t('packageWorkspace')}</option>
          </NativeSelect>}</FormField>
          <div className="form-columns">
            <FormField label={t('packageSkillFile')}>{props => <Input {...props} name="skill" type="file" accept=".md" required />}</FormField>
            <FormField label={t('packageFileLanguage')}>{props => <NativeSelect {...props} name="fileLocale" defaultValue={locale}>
              <option value="en">English</option><option value="zh-CN">简体中文</option>
            </NativeSelect>}</FormField>
          </div>
          <p className="muted m-0">{t('packageFileHint')}</p>
          <div className="form-columns">
            <FormField label={t('packageReferences')}>{props => <Input {...props} name="references" type="file" accept=".md" multiple />}</FormField>
            <FormField label={t('packageAssets')}>{props => <Input {...props} name="assets" type="file" accept=".json" multiple />}</FormField>
          </div>
        </fieldset>
        {submit.error && <Failure error={submit.error} locale={locale} />}
        <div className="actions"><Button type="submit" disabled={submit.isPending}>{t('saveRuleDraft')}</Button></div>
      </form>
    </Panel>
  </>;
}
