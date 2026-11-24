import { useState } from 'react';
import { rulePackageActivationViewSchema, rulePackageDetailSchema, rulePackagePageSchema } from '@itervane/contracts';
import { EmptyState, Failure, Loading, PageHeading, Panel, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Table } from '../ui/table.js';

const kindLabels = { design_skill: 'packageDesign', code_rule: 'packageCodeRule', runbook: 'packageRunbook' } as const;
const versionHash = (packageId: string, versionId: string) => `#/rule-packages/${packageId}/versions/${versionId}`;

export function RuleLibraryPage() {
  const { locale } = usePortal();
  const t = useText();
  const [before, setBefore] = useState<string | null>(null);
  const page = useRemote(`/v1/rule-packages?limit=25${before ? `&before=${before}` : ''}`, rulePackagePageSchema,
    { localized: true });
  const nextBefore = page.data?.nextBefore;
  return <>
    <PageHeading title={t('ruleLibrary')} actions={<a href="#/rule-packages/import">{t('importDesignSkill')}</a>} />
    <Panel title={t('packageVersion')} className="section-gap">
      {page.isPending ? <Loading locale={locale} /> : page.error ? <Failure error={page.error} locale={locale} retry={() => { void page.refetch(); }} />
        : page.data.items.length === 0 ? <EmptyState title={t('noRulePackages')} /> : <Table label={t('packageVersion')}>
          <thead><tr><th scope="col">{t('packageName')}</th><th scope="col">{t('packageScope')}</th><th scope="col">{t('packageApproval')}</th></tr></thead>
          <tbody>{page.data.items.map(item => <tr key={item.versionId}>
            <td><a href={versionHash(item.packageId, item.versionId)}>{item.text.title}</a>
              <div className="muted break-text"><code>{item.packageKey}</code> · {item.version} · {t(kindLabels[item.kind])}</div></td>
            <td>{t(item.scope.kind === 'workspace' ? 'packageWorkspace' : 'packageProject')}</td>
            <td>{item.reviewMessage}</td>
          </tr>)}</tbody>
        </Table>}
      {(before || nextBefore) && <div className="actions section-gap">
        {before && <Button variant="outline" onClick={() => setBefore(null)}>{t('newestVersions')}</Button>}
        {nextBefore && <Button variant="outline" onClick={() => setBefore(nextBefore)}>{t('earlierVersions')}</Button>}
      </div>}
    </Panel>
  </>;
}

export function RulePackagePage({ packageId, versionId }: { packageId: string; versionId: string }) {
  const { locale } = usePortal();
  const t = useText();
  const packagePath = `/v1/rule-packages/${packageId}`;
  const revision = useRemote(`${packagePath}/versions/${versionId}`, rulePackageDetailSchema, { localized: true, poll: true });
  const activations = useRemote(`${packagePath}/activation`, rulePackageActivationViewSchema, { localized: true, poll: true });
  const error = revision.error ?? activations.error;
  if (error) return <Failure error={error} locale={locale} retry={() => { void revision.refetch(); void activations.refetch(); }} />;
  if (!revision.data || !activations.data) return <Loading locale={locale} />;
  const version = revision.data;
  const { document } = version;
  const { current, history } = activations.data;
  return <>
    <a href="#/rule-packages" className="back-link">← {t('ruleLibrary')}</a>
    <PageHeading title={version.text.title} description={version.text.description} />
    <Panel title={t('packageVersion')} className="section-gap">
      <div className="actions"><Badge>{t(kindLabels[version.kind])}</Badge>
        {current?.versionId === versionId && <Badge>{t('packageActive')}</Badge>}</div>
      <dl className="detail-grid section-gap">
        <div><dt>{t('version')}</dt><dd><code>{version.packageKey}</code> · {version.version}</dd></div>
        <div><dt>{t('packageScope')}</dt><dd>{document.scope.kind === 'workspace' ? t('packageWorkspace')
          : <a href={`#/projects/${document.scope.projectId}`}>{t('packageProject')}</a>}</dd></div>
        <div><dt>{t('packageSource')}</dt><dd>{version.source.url
          ? <a href={version.source.url} target="_blank" rel="noopener noreferrer">{version.source.name}</a> : version.source.name}
          {' · '}{version.source.license}</dd></div>
        <div><dt>{t('packageApproval')}</dt><dd>{version.reviewMessage}</dd></div>
      </dl>
      <p className="muted">{t('packageFingerprint')} <code className="break-text">{version.sha256}</code></p>
    </Panel>
    <Panel title={t('packageMaterial')} className="section-gap">
      {document.kind === 'design_skill' ? [document.skill, ...document.resources].map(file => <Disclosure key={file.path} title={file.path}>
        <pre className="whitespace-pre-wrap break-words" dir="auto">{file.content}</pre>
      </Disclosure>) : <>
        <p><a href={`#/tasks/${document.validation.taskId}`}>{t('packageEvidenceLink')}</a></p>
        <p className="muted">{t('packageValidation')} <code className="break-text">{document.validation.sha256}</code></p>
        <Disclosure title={document.candidate.text[locale].title}>
          <p>{document.candidate.text[locale].appliesTo}</p><p>{document.candidate.text[locale].limitation}</p>
          <pre className="whitespace-pre-wrap break-words" dir="auto">{JSON.stringify(document.candidate, null, 2)}</pre>
        </Disclosure>
      </>}
    </Panel>
    <Panel title={t('packageActivationHistory')}>
      {current ? <p><a href={versionHash(packageId, current.versionId)}>{t('packageActive')}</a></p> : <p>{t('packageInactive')}</p>}
      {history.length > 0 && <ol className="grid list-none gap-3 p-0">
        {history.map(entry => <li key={entry.sequence}>
          <a href={versionHash(packageId, entry.versionId)}>{entry.message}</a>
          <span className="muted ml-2"><time dateTime={entry.recordedAt}>{formatTime(entry.recordedAt, locale)}</time></span>
        </li>)}
      </ol>}
    </Panel>
  </>;
}
