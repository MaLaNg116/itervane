import { Alert, Card, Empty, Tag } from 'antd';
import { preauditDtoSchema } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { Failure, Loading, PageHeading, formatTime } from '../components.js';
import { Disclosure } from '../motion.js';

export function PreauditReportPage({ id }: { id: string }) {
  const { locale } = usePortal(); const t = useText();
  const report = useRemote(`/v1/preaudits/${id}`, preauditDtoSchema, { localized: true, poll: true });
  if (report.isPending) return <Loading locale={locale} />;
  if (report.error) return <Failure error={report.error} locale={locale} retry={() => { void report.refetch(); }} />;
  const value = report.data;
  return <>
    <a href={`#/projects/${value.projectId}/preaudit`} className="back-link">← {t('backPreaudit')}</a>
    <PageHeading title={t('preauditReport')} description={value.id} actions={<Tag color={value.outcome === 'observations' ? 'warning' : 'default'}>{t(`outcome_${value.outcome}`)}</Tag>} />
    <Alert type="info" showIcon title={t('preauditBoundary')} className="section-gap" />
    <Card title={t('observations')} className="section-gap" data-testid="preaudit-observations">
      {value.observations.length === 0 ? <Empty description={t('noObservations')} /> : value.observations.map((observation, index) => <section className="rule-material" key={`${observation.ruleId}-${observation.inputLine}`}>
        <h3>{index + 1}. {observation.title} <Tag>{t(`certainty_${observation.certainty}`)}</Tag></h3>
        <p className="muted">{t('inputLine')}: {observation.inputLine}{observation.sourceLine === null ? '' : ` · ${t('sourceLine')}: ${observation.sourceLine}`} · {observation.ruleId} · {observation.ruleVersion}</p>
        <p>{observation.guidance}</p><p className="muted">{observation.limitation}</p>
      </section>)}
    </Card>
    <Card title={t('coverage')} className="section-gap">
      <ul>{value.coverage.map(coverage => <li key={coverage.ruleId}>{coverage.title} — {t(`coverage_${coverage.status}`)}</li>)}</ul>
      <h3>{t('uncovered')}</h3><ul data-testid="preaudit-uncovered">{value.uncovered.map(item => <li key={item.code}>{item.message}</li>)}</ul>
    </Card>
    <Card>
      <Disclosure title={t('reportMetadata')}><dl className="detail-grid">
        <div><dt>{t('createdAt')}</dt><dd>{formatTime(value.createdAt, locale)}</dd></div><div><dt>{t('codeLanguage')}</dt><dd>{value.input.language}</dd></div>
        <div><dt>{t('inputFormat')}</dt><dd>{t(value.input.format === 'snippet' ? 'snippet' : 'unifiedDiff')}</dd></div>
        <div><dt>{t('inputBytes')} / {t('inputLines')} / {t('analyzedLines')}</dt><dd>{value.input.bytes} / {value.input.lines} / {value.input.analyzedLines}</dd></div>
        <div><dt>{t('catalogVersion')} / {t('engineVersion')}</dt><dd>{value.catalogVersion} / {value.engineVersion}</dd></div>
        <div><dt>{t('catalogDigest')}</dt><dd><code>{value.catalogSha256}</code></dd></div>
        <div><dt>{t('inputDigest')}</dt><dd><code>{value.input.sha256}</code></dd></div><div><dt>{t('reportDigest')}</dt><dd><code>{value.reportSha256}</code></dd></div>
      </dl></Disclosure>
    </Card>
  </>;
}
