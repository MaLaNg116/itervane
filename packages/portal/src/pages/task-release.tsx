import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formalReleaseCandidateDtoSchema, formalReleaseDecisionResultSchema, formalReleaseViewSchema,
  type FormalReleaseView, type ReleaseDecision, type TaskDto } from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure, Loading, Panel, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { StartOperationsObservation } from './task-operations.js';

const decisions = {
  confirm: { action: 'releaseApprove', title: 'releaseApproveTitle', help: 'releaseApproveHelp', result: 'releaseApproved' },
  reject: { action: 'releaseReject', title: 'releaseRejectTitle', help: 'releaseRejectHelp', result: 'releaseRejected' },
  revoke: { action: 'releaseRevoke', title: 'releaseRevokeTitle', help: 'releaseRevokeHelp', result: 'releaseRevoked' },
} as const;
const severities = {
  critical: 'auditSeverityCritical', high: 'auditSeverityHigh', medium: 'auditSeverityMedium',
  low: 'auditSeverityLow', unknown: 'auditSeverityUnknown',
} as const;

type PendingDecision = {
  candidateId: string; action: ReleaseDecision; fingerprint: string; expectedVersion: number; idempotencyKey: string;
};

function ReleaseResult({ result }: { result: NonNullable<FormalReleaseView['result']> }) {
  const { locale } = usePortal();
  const t = useText();
  return <section className="space-y-2" data-testid="release-result">
    <h3 className="text-sm font-semibold">{t('releaseResult')}</h3>
    <div role="status" aria-atomic="true">
      <p>{result.message}</p>
      {(result.status === 'manual_review' || result.status === 'blocked') && result.reasonMessage &&
        <p className="muted">{result.reasonMessage}</p>}
    </div>
    {result.updateId && <dl className="detail-grid">
      <div><dt>{t('releaseNativeUpdate')}</dt><dd><code className="break-text">{result.updateId}</code></dd></div>
      {result.status === 'verified' && <>
        <div><dt>{t('releaseObservedImage')}</dt><dd><code className="break-text">{result.evidence.manifestDigest}</code></dd></div>
        <div><dt>{t('releaseObservedVersion')}</dt><dd><code className="break-text">{result.evidence.version}</code></dd></div>
        <div><dt>{t('releaseCheckedAt')}</dt><dd><time dateTime={result.evidence.checkedAt}>
          {formatTime(result.evidence.checkedAt, locale)}</time></dd></div>
      </>}
    </dl>}
  </section>;
}

function CandidateDetails({ candidate, target, result }: {
  candidate: NonNullable<FormalReleaseView['candidate']>; target: FormalReleaseView['candidateTarget']; result: FormalReleaseView['result'];
}) {
  const { locale } = usePortal();
  const t = useText();
  const numbers = new Intl.NumberFormat(locale);
  const { manifest } = candidate;
  return <div className="space-y-3">
    {result ? <ReleaseResult result={result} /> : <p role="status" aria-atomic="true">{candidate.message}</p>}
    <dl className="detail-grid">
      <div><dt>{t('releaseTarget')}</dt><dd>{target ? `${target.applicationName} / ${target.environmentName}`
        : <code className="break-text">{manifest.target.environmentId}</code>}</dd></div>
      <div><dt>{t('releaseTargetRevision')}</dt><dd>{numbers.format(manifest.target.revision)}</dd></div>
      <div><dt>{t('releaseDeadline')}</dt><dd><time dateTime={manifest.validUntil}>{formatTime(manifest.validUntil, locale)}</time></dd></div>
      <div><dt>{t('releaseFindings')}</dt><dd><ul className="flex flex-wrap gap-x-3 gap-y-1">
        {(Object.keys(severities) as Array<keyof typeof severities>).map(severity =>
          <li key={severity}>{t(severities[severity])} {numbers.format(manifest.image.findings[severity])}</li>)}
      </ul></dd></div>
      <div><dt>{t('verificationImageDigest')}</dt><dd><code className="break-text">{manifest.image.manifestDigest}</code></dd></div>
    </dl>
    <Disclosure title={t('releaseEvidence')}>
      <dl className="detail-grid">
        <div><dt>{t('releaseFingerprint')}</dt><dd><code className="break-text">{candidate.fingerprint}</code></dd></div>
        <div><dt>{t('releaseSourceSnapshot')}</dt><dd><code className="break-text">{manifest.repairedSnapshotSha256}</code></dd></div>
        <div><dt>{t('verificationResult')}</dt><dd><code className="break-text">{manifest.verification.resultSha256}</code></dd></div>
        {candidate.operationId && <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{candidate.operationId}</code></dd></div>}
      </dl>
    </Disclosure>
    {candidate.decisions.length > 0 && <section className="space-y-2">
      <h3 className="text-sm font-semibold">{t('releaseHistory')}</h3>
      <ol className="space-y-1">
        {candidate.decisions.map(item => <li key={item.version} className="flex flex-wrap gap-x-3 gap-y-1">
          <span>{t(decisions[item.action].result)}</span>{item.selfConfirmed && <span>{t('releaseSelfConfirmed')}</span>}
          <time dateTime={item.decidedAt} className="muted">{formatTime(item.decidedAt, locale)}</time>
          <code className="break-text muted">{item.actorId}</code>
        </li>)}
      </ol>
    </section>}
  </div>;
}

export function TaskRelease({ task, canWrite }: { task: Pick<TaskDto, 'id' | 'projectId' | 'runId' | 'version'>; canWrite: boolean }) {
  const { api, locale } = usePortal();
  const t = useText();
  const cache = useQueryClient();
  const query = useRemote(`/v1/tasks/${task.id}/release`, formalReleaseViewSchema, { localized: true, revision: task.version, poll: true });
  const [selection, setSelection] = useState('');
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const view = !query.error && query.data?.taskId === task.id && query.data.runId === task.runId
    && query.data.taskVersion === task.version ? query.data : undefined;
  const candidate = view?.candidate;
  const activeDecision = pending && candidate?.id === pending.candidateId && candidate.fingerprint === pending.fingerprint
    && candidate.decisionVersion === pending.expectedVersion && view?.actions.includes(pending.action) ? pending : null;
  useEffect(() => { if (!activeDecision) setPending(null); }, [activeDecision]);

  const refresh = () => { inFlight.current = false; void cache.invalidateQueries(); };
  const prepare = useMutation({
    retry: false,
    mutationFn: (input: { environmentId: string; expectedVersion: number }) => api.request(`/v1/tasks/${task.id}/release-candidate`,
      formalReleaseCandidateDtoSchema, locale, { method: 'POST', body: input }),
    onSettled: refresh,
  });
  const decide = useMutation({
    retry: false,
    mutationFn: ({ candidateId, ...input }: PendingDecision) => api.request(`/v1/release-candidates/${candidateId}/decisions`,
      formalReleaseDecisionResultSchema, locale, { method: 'POST', body: input }),
    onSuccess: () => setPending(null),
    onError: error => { if (error instanceof ApiFailure && error.code) setPending(null); },
    onSettled: refresh,
  });
  const busy = prepare.isPending || decide.isPending;
  const targets = view?.availableTargets ?? [];
  const environmentId = targets.find(target => target.environmentId === selection)?.environmentId
    ?? (targets.length === 1 ? targets[0]!.environmentId : '');
  const copy = activeDecision && decisions[activeDecision.action];
  return <Panel title={t('formalRelease')} className="section-gap" data-testid="formal-release">
    {query.error ? <Failure error={query.error} locale={locale} retry={() => { void query.refetch(); }} />
      : !view ? <Loading locale={locale} /> : <div className="space-y-4">
        {candidate ? <CandidateDetails key={candidate.id} candidate={candidate} target={view.candidateTarget} result={view.result} />
          : <p className="muted" role="status">{t('releaseNoCandidate')}</p>}
        {targets.length > 0 && <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
          event.preventDefault();
          if (!environmentId || busy || inFlight.current) return;
          inFlight.current = true;
          prepare.mutate({ environmentId, expectedVersion: view.taskVersion });
        }}>
          <label className="grid min-w-0 max-w-full gap-1.5 text-sm">
            <span>{t('releaseTarget')}</span>
            <select value={environmentId} onChange={event => setSelection(event.target.value)} disabled={busy}
              className="h-9 w-full max-w-full min-w-0 rounded-md border border-solid border-input bg-background px-3 text-sm">
              {targets.length > 1 && <option value="" disabled>{t('releaseTarget')}</option>}
              {targets.map(target => <option key={target.environmentId} value={target.environmentId}>
                {target.applicationName} / {target.environmentName} ({t('releaseTargetRevision')} {target.revision})
              </option>)}
            </select>
          </label>
          <Button type="submit" variant="outline" disabled={!environmentId || busy}>{t('releasePrepare')}</Button>
        </form>}
        {candidate && view.actions.length > 0 && <div className="flex flex-wrap gap-2">
          {view.actions.map(action => <Button key={action} variant={action === 'confirm' ? 'default' : 'outline'} disabled={busy} onClick={() => {
            decide.reset();
            setPending({ action, candidateId: candidate.id, fingerprint: candidate.fingerprint,
              expectedVersion: candidate.decisionVersion, idempotencyKey: crypto.randomUUID() });
          }}>{t(decisions[action].action)}</Button>)}
        </div>}
        {prepare.error && <Failure error={prepare.error} locale={locale} />}
        {decide.error && !activeDecision && <Failure error={decide.error} locale={locale} />}
        <Dialog open={!!activeDecision} disablePointerDismissal onOpenChange={(open, event) => {
          if (open) return;
          if (inFlight.current) event.cancel();
          else setPending(null);
        }}>
          {copy && candidate && <DialogContent initialFocus={backButton} aria-busy={decide.isPending}>
            <DialogTitle>{t(copy.title)}</DialogTitle>
            <DialogDescription>{t(copy.help)}</DialogDescription>
            <dl className="detail-grid">
              <div><dt>{t('releaseFingerprint')}</dt><dd><code className="break-text">{candidate.fingerprint}</code></dd></div>
              <div><dt>{t('verificationImageDigest')}</dt><dd><code className="break-text">{candidate.manifest.image.manifestDigest}</code></dd></div>
            </dl>
            {decide.error && <Failure error={decide.error} locale={locale} />}
            <DialogFooter>
              <DialogClose disabled={decide.isPending} render={<Button ref={backButton} variant="outline" />}>{t('cancel')}</DialogClose>
              <Button variant={activeDecision.action === 'confirm' ? 'default' : 'destructive'} disabled={busy} onClick={() => {
                if (inFlight.current) return;
                inFlight.current = true;
                decide.mutate(activeDecision);
              }}>{t(copy.action)}</Button>
            </DialogFooter>
          </DialogContent>}
        </Dialog>
      </div>}
    {canWrite && <StartOperationsObservation taskId={task.id} projectId={task.projectId}
      releaseOperationId={view?.result?.status === 'verified' ? view.result.operationId : undefined} />}
  </Panel>;
}
