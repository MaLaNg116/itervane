import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { operationsProposalViewSchema, type ReleaseDecision, type TaskDto } from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { OperationsRestartExecution } from './task-operations-restart.js';

const decisionText = {
  confirm: { button: 'operationsApprove', result: 'releaseApproved' },
  reject: { button: 'operationsReject', result: 'releaseRejected' },
  revoke: { button: 'releaseRevoke', result: 'releaseRevoked' },
} as const;

type PendingDecision = {
  proposalId: string; fingerprint: string; expectedVersion: number; idempotencyKey: string; action: ReleaseDecision;
};

export function OperationsProposal({ task }: { task: Pick<TaskDto, 'id' | 'runId' | 'version'> }) {
  const { api, locale } = usePortal();
  const t = useText();
  const path = `/v1/tasks/${task.id}/operations-proposal`;
  const query = useRemote(path, operationsProposalViewSchema, { localized: true, revision: task.version, poll: true });
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const view = !query.error && query.data?.taskId === task.id && query.data.runId === task.runId && query.data.taskVersion === task.version
    ? query.data : undefined;
  const proposal = view?.proposal;
  const version = proposal?.decisions.at(-1)?.version ?? 0;
  const decision = pending && proposal?.id === pending.proposalId && proposal.fingerprint === pending.fingerprint
    && version === pending.expectedVersion && proposal.actions.includes(pending.action) ? pending : null;
  useEffect(() => { if (!decision) setPending(null); }, [decision]);
  const refresh = () => { void query.refetch(); };
  const prepare = useMutation({
    retry: false,
    mutationFn: (diagnosisSha256: string) => api.request(path, operationsProposalViewSchema, locale, { method: 'POST', body: { diagnosisSha256 } }),
    onSettled: refresh,
  });
  const submit = useMutation({
    retry: false,
    mutationFn: ({ proposalId, ...body }: PendingDecision) => api.request(`/v1/operations/proposals/${proposalId}/decisions`,
      operationsProposalViewSchema, locale, { method: 'POST', body }),
    onSuccess: () => setPending(null),
    onError: error => { if (error instanceof ApiFailure && error.code) setPending(null); },
    onSettled: refresh,
  });
  if (query.error) {
    if (query.error instanceof ApiFailure && query.error.code === 'not_found') return null;
    return <Failure error={query.error} locale={locale} retry={refresh} />;
  }
  if (!view?.draft && !proposal) return null;
  const busy = prepare.isPending || submit.isPending;
  const failure = prepare.error ?? submit.error;
  return <section className="space-y-3" data-testid="operations-proposal">
    <h3 className="text-sm font-semibold">{t('operationsProposal')}</h3>
    {view?.draft && <Button type="button" variant="outline" disabled={busy}
      onClick={() => { if (view.draft) prepare.mutate(view.draft.diagnosisSha256); }}>
      {t(view.draft.kind === 'restart' ? 'operationsPrepareRestart' : 'operationsPrepareRollback')}
    </Button>}
    {proposal && <>
      <div>
        <p className="font-medium">{t(proposal.kind === 'restart' ? 'operationsRestart' : 'operationsRollback')}</p>
        <p className="muted" role="status">{proposal.message}</p>
      </div>
      <dl className="detail-grid">
        <div><dt>{t('releaseDeadline')}</dt><dd><time dateTime={proposal.validUntil}>{formatTime(proposal.validUntil, locale)}</time></dd></div>
        <div><dt>{t('operationsCurrentImage')}</dt><dd><code className="break-text">{proposal.current.manifestDigest}</code></dd></div>
        {proposal.restore && <div><dt>{t('operationsRestoreImage')}</dt><dd><code className="break-text">{proposal.restore.manifestDigest}</code></dd></div>}
      </dl>
      <Disclosure title={t('operationsProposalDigest')}><code className="break-text">{proposal.fingerprint}</code></Disclosure>
      {proposal.decisions.length > 0 && <ol aria-label={t('releaseHistory')} className="space-y-1">
        {proposal.decisions.map(item => <li key={item.version} className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <span>{t(decisionText[item.action].result)}</span>
          {item.selfConfirmed && <span>{t('releaseSelfConfirmed')}</span>}
          <time className="muted" dateTime={item.decidedAt}>{formatTime(item.decidedAt, locale)}</time>
        </li>)}
      </ol>}
      {proposal.actions.length > 0 && <div className="flex flex-wrap gap-2">
        {proposal.actions.map(action => <Button key={action} type="button" disabled={busy}
          variant={action === 'confirm' ? 'default' : 'outline'} onClick={() => {
            submit.reset();
            setPending({ proposalId: proposal.id, fingerprint: proposal.fingerprint, expectedVersion: version, action, idempotencyKey: crypto.randomUUID() });
          }}>{t(decisionText[action].button)}</Button>)}
      </div>}
      {proposal.kind === 'restart' && <OperationsRestartExecution key={proposal.id} task={task} proposal={proposal} decisionBusy={busy} />}
    </>}
    {failure && !decision && <Failure error={failure} locale={locale} />}
    <Dialog open={!!decision} onOpenChange={open => { if (!open && !submit.isPending) setPending(null); }}>
      {decision && proposal && <DialogContent>
        <DialogTitle>{t('operationsDecisionTitle')}</DialogTitle>
        <DialogDescription>{t('operationsDecisionHelp')}</DialogDescription>
        <div>
          <p className="font-medium">{t(proposal.kind === 'restart' ? 'operationsRestart' : 'operationsRollback')}</p>
          <dl className="detail-grid mt-2">
            <div><dt>{t('operationsCurrentImage')}</dt><dd><code className="break-text">{proposal.current.manifestDigest}</code></dd></div>
            {proposal.restore && <div><dt>{t('operationsRestoreImage')}</dt><dd><code className="break-text">{proposal.restore.manifestDigest}</code></dd></div>}
          </dl>
        </div>
        {submit.error && <Failure error={submit.error} locale={locale} />}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={submit.isPending} />}>{t('cancel')}</DialogClose>
          <Button type="button" disabled={submit.isPending} onClick={() => submit.mutate(decision)}>{t(decisionText[decision.action].button)}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </section>;
}
