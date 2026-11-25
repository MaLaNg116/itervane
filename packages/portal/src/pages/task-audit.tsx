import { formalAuditDtoSchema, type AuditScanner, type FormalAuditResult } from '@itervane/contracts';
import { Failure, Loading, Panel } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Badge } from '../ui/badge.js';

const severityLabels = { unknown: 'auditSeverityUnknown', low: 'auditSeverityLow', medium: 'auditSeverityMedium',
  high: 'auditSeverityHigh', critical: 'auditSeverityCritical' } as const;
const scannerNames: Record<AuditScanner, string> = { gitleaks: 'gitleaks', trivy: 'trivy', semgrep_ce: 'Semgrep CE' };

export function TaskAudit({ taskId }: { taskId: string }) {
  const { locale } = usePortal(); const t = useText();
  const audit = useRemote(`/v1/tasks/${taskId}/audit`, formalAuditDtoSchema, { poll: true, localized: true });
  return <Panel title={t('formalAudit')} className="section-gap" data-testid="formal-audit">
    {audit.isPending ? <Loading locale={locale} /> : audit.error
      ? <Failure error={audit.error} locale={locale} retry={() => { void audit.refetch(); }} />
      : <>
        <p role="status" className={audit.data.status === 'unavailable' ? 'font-medium' : 'muted'}>{audit.data.message}</p>
        {audit.data.status === 'recorded' && <AuditResult result={audit.data.result} sha256={audit.data.sha256} />}
      </>}
  </Panel>;
}

function AuditResult({ result, sha256 }: { result: FormalAuditResult; sha256: string }) {
  const t = useText();
  const { checklist } = result;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={result.status === 'completed' ? 'success' : 'warning'}>{t(result.status === 'completed' ? 'auditRecorded' : 'auditHumanReview')}</Badge>
      {checklist && <Badge>{t(checklist.coverage === 'complete' ? 'auditScopedCoverage' : 'auditPartialCoverage')}</Badge>}
    </div>
    {checklist && <>
      <p lang={result.locale}>{checklist.summary}</p>
      {checklist.findings.length === 0 && <p className="muted">{t('auditNoFindings')}</p>}
      {checklist.findings.length > 0 && <ul className="space-y-3" aria-label={t('scanFindings')}>
        {checklist.findings.map(finding => <li key={finding.id} className="rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2"><strong>{scannerNames[finding.scanner]} <code>{finding.ruleId}</code></strong>
            <Badge>{t(severityLabels[finding.severity])}</Badge>
            <Badge variant={finding.certainty === 'suspected' ? 'warning' : 'info'}>{t(finding.certainty === 'suspected' ? 'auditSuspected' : 'auditConfirmed')}</Badge>
          </div>
          <p><code className="break-text">{finding.path}{finding.line === null ? '' : `:${finding.line}`}</code></p>
          <dl className="detail-grid">
            <div><dt>{t('auditImpact')}</dt><dd lang={result.locale}>{finding.impact}</dd></div>
            <div><dt>{t('auditSuggestion')}</dt><dd lang={result.locale}>{finding.suggestion}</dd></div>
          </dl>
        </li>)}
      </ul>}
      {checklist.hypotheses.length > 0 && <>
        <h3>{t('auditHypotheses')}</h3>
        <ul lang={result.locale}>{checklist.hypotheses.map((item, index) => <li key={index}>{item.description}</li>)}</ul>
      </>}
      <ul className="muted" lang={result.locale}>{checklist.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
    </>}
    <details>
      <summary>{t('auditEvidence')}</summary>
      <p><code className="break-text">{sha256}</code></p>
      <ul>{result.evidence.map(item => <li key={item.id}>
        {item.kind === 'scan' ? <><strong>{scannerNames[item.scanner]} {item.version}</strong> · {t('scanFindings')} {item.totalFindings}</>
          : <strong>{item.kind === 'rule' ? item.ruleId : t('auditHealthReproduction')}</strong>}
        <br /><code className="break-text">{item.id}</code>
      </li>)}</ul>
    </details>
  </div>;
}
