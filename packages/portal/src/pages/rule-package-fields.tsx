import { FormField } from '../forms.js';
import { useText } from '../context.js';
import { Input, Textarea } from '../ui/fields.js';

export function readPackageMetadata(form: FormData) {
  const sourceUrl = form.get('sourceUrl');
  return {
    packageKey: form.get('packageKey'), version: form.get('version'),
    source: { name: form.get('sourceName'), license: form.get('license'), url: sourceUrl || undefined },
    text: { en: { title: form.get('titleEn'), description: form.get('descriptionEn') },
      'zh-CN': { title: form.get('titleZh'), description: form.get('descriptionZh') } },
  };
}

export function RulePackageFields() {
  const t = useText();
  return <>
    <div className="form-columns">
      <FormField label={t('packageKey')} hint={t('packageKeyHint')}>{props =>
        <Input {...props} name="packageKey" required maxLength={64} pattern="[a-z][a-z0-9\-]{0,63}" autoComplete="off" />}
      </FormField>
      <FormField label={t('version')} hint={t('packageVersionHint')}>{props =>
        <Input {...props} name="version" required defaultValue="1.0.0" maxLength={32} autoComplete="off" />}
      </FormField>
    </div>
    <div className="form-columns">
      <FormField label={t('packageSourceName')}>{props => <Input {...props} name="sourceName" required maxLength={160} />}</FormField>
      <FormField label={t('packageLicense')}>{props => <Input {...props} name="license" required maxLength={64} />}</FormField>
    </div>
    <FormField label={t('packageSourceUrl')}>{props => <Input {...props} name="sourceUrl" type="url" maxLength={2048} />}</FormField>
    <div className="form-columns">
      <FormField label={t('packageTitleEn')}>{props => <Input {...props} name="titleEn" lang="en" required maxLength={160} />}</FormField>
      <FormField label={t('packageTitleZh')}>{props => <Input {...props} name="titleZh" lang="zh-CN" required maxLength={160} />}</FormField>
    </div>
    <div className="form-columns">
      <FormField label={t('packageDescriptionEn')}>{props => <Textarea {...props} name="descriptionEn" lang="en" rows={3} required maxLength={1_200} />}</FormField>
      <FormField label={t('packageDescriptionZh')}>{props => <Textarea {...props} name="descriptionZh" lang="zh-CN" rows={3} required maxLength={1_200} />}</FormField>
    </div>
  </>;
}
