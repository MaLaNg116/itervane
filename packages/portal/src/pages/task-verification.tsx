import { verificationViewSchema, type RecordedVerificationView } from '@itervane/contracts';
import { Failure, Loading, Panel, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Badge } from '../ui/badge.js';

const outcomes = {
  observed: 'verificationObserved', checks_failed: 'verificationChecksFailed', source_findings: 'verificationSourceFindings',
  incomplete: 'verificationIncomplete', requires_human: 'verificationNeedsHuman',
} as const;
const stages = {
  not_requested: 'verificationNotRequested', not_reached: 'verificationNotReached', blocked: 'verificationBlocked',
  failed: 'scanFailed', built: 'verificationBuilt', passed: 'verificationPassed', scanned: 'verificationScanned',
} as const;
const checks = {
  health: 'verificationHealth', version: 'verificationVersion', synthetic_data: 'verificationData', page: 'verificationPage',
  compiled_asset: 'verificationAsset',
} as const;
const checkReasons = {
  unexpected_status: 'verificationUnexpectedStatus', unexpected_content: 'verificationUnexpectedContent',
  timeout: 'verificationTimeout', unavailable: 'verificationUnavailable', missing_page_asset: 'verificationMissingAsset',
} as const;
const severities = {
  critical: 'auditSeverityCritical', high: 'auditSeverityHigh', medium: 'auditSeverityMedium', low: 'auditSeverityLow', unknown: 'auditSeverityUnknown',
} as const;

function VerificationRecord({ record, current }: { record: RecordedVerificationView; current?: boolean }) {
  const { locale } = usePortal();
  const t = useText();
  const numbers = new Intl.NumberFormat(locale);
  const { source, build, baseline, image } = record;
  return <div className="space-y-3">
    <div className="space-y-2" role={current ? 'status' : undefined} aria-atomic={current ? true : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant={record.outcome === 'observed' ? 'success' : 'warning'}>{t(outcomes[record.outcome])}</Badge>
        <span className="muted">{t('verificationGeneration')} {numbers.format(record.generation)}</span>
        <time dateTime={record.recordedAt} className="muted">{formatTime(record.recordedAt, locale)}</time>
      </div>
      <p>{record.message}</p>
    </div>
    <dl className="detail-grid">
      <div><dt>{t('verificationSourceComparison')}</dt><dd>{source.status === 'compared' ? <ul>
        <li>{t('verificationIntroduced')} {numbers.format(source.introduced)}</li>
        <li>{t('verificationResolved')} {numbers.format(source.resolved)}</li>
        <li>{t('verificationRemaining')} {numbers.format(source.remaining)}</li>
      </ul> : t('verificationUnavailable')}</dd></div>
      <div><dt>{t('verificationBuild')}</dt><dd>{t(stages[build.status])}</dd></div>
      <div><dt>{t('verificationBaseline')}</dt><dd>{t(stages[baseline.status])}
        {baseline.status === 'failed' && <ul className="mt-1 space-y-1">
          {baseline.failures.map(check => <li key={check.id}>{t(checks[check.id])} · {t(checkReasons[check.code])}
            {check.statusCode !== null && <> ({check.statusCode})</>}
          </li>)}
        </ul>}
      </dd></div>
      <div><dt>{t('verificationImage')}</dt><dd>{t(stages[image.status])}
        {image.status === 'scanned' && <ul className="mt-1 space-y-1">
          {(Object.keys(severities) as Array<keyof typeof severities>).map(severity => <li key={severity}>
            {t(severities[severity])} {numbers.format(image.findings[severity])}
          </li>)}
        </ul>}
      </dd></div>
      {image.status === 'scanned' && <div><dt>{t('verificationImageDigest')}</dt><dd><code className="break-text">{image.manifestDigest}</code></dd></div>}
    </dl>
    <Disclosure title={t('verificationEvidence')}>
      <dl className="detail-grid">
        <div><dt>{t('runId')}</dt><dd><code className="break-text">{record.runId}</code></dd></div>
        <div><dt>{t('repairManifest')}</dt><dd><code className="break-text">{record.candidateManifestSha256}</code></dd></div>
        <div><dt>{t('verificationResult')}</dt><dd><code className="break-text">{record.resultSha256}</code></dd></div>
        <div><dt>{t('inspectionReceipt')}</dt><dd><code className="break-text">{record.receiptSha256}</code></dd></div>
      </dl>
    </Disclosure>
  </div>;
}

export function TaskVerification({ taskId, runId, revision }: { taskId: string; runId: string; revision: number }) {
  const { locale } = usePortal();
  const t = useText();
  const query = useRemote(`/v1/tasks/${taskId}/verification`, verificationViewSchema, { localized: true, revision });
  return <Panel title={t('formalVerification')} className="section-gap" data-testid="formal-verification">
    {query.error ? <Failure error={query.error} locale={locale} retry={() => { void query.refetch(); }} />
      : !query.data || query.data.current.runId !== runId ? <Loading locale={locale} /> : <div className="space-y-4">
        {query.data.current.status === 'recorded' ? <VerificationRecord record={query.data.current} current />
          : <p role="status">{query.data.current.message}</p>}
        {query.data.previous && <Disclosure key={query.data.previous.runId} title={t('verificationPrevious')}>
          <VerificationRecord record={query.data.previous} />
        </Disclosure>}
      </div>}
  </Panel>;
}
