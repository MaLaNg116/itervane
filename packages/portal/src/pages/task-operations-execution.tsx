import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { operationsRestartExecutionViewSchema, operationsRestoreExecutionViewSchema, operationsSubmissionSchema, type OperationsProposalView,
  type OperationsRestartExecutionView, type OperationsRestoreExecutionView, type TaskDto } from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';

type Proposal = NonNullable<OperationsProposalView['proposal']>;
type ExecutionView = OperationsRestartExecutionView | OperationsRestoreExecutionView;
type ExecutionAction = NonNullable<ExecutionView['action']>;
type Pending = { action: ExecutionAction; idempotencyKey: string };
const actions = {
  enqueue: { label: 'operationsQueueRestart', title: 'operationsQueueRestartTitle', help: 'operationsQueueRestartHelp' },
  continue: { label: 'operationsContinueRestart', title: 'operationsContinueRestartTitle', help: 'operationsContinueRestartHelp' },
} as const;
const restoreAction = { label: 'operationsQueueRestore', title: 'operationsQueueRestoreTitle', help: 'operationsQueueRestoreHelp' } as const;

function sameAction(saved: ExecutionAction, current: ExecutionAction) {
  if (saved.kind === 'enqueue' && current.kind === 'enqueue') {
    return saved.proposalId === current.proposalId && saved.fingerprint === current.fingerprint && saved.decisionVersion === current.decisionVersion;
  }
  return saved.kind === 'continue' && current.kind === 'continue' && saved.executionId === current.executionId
    && saved.expectedVersion === current.expectedVersion && saved.approvalId === current.approvalId && saved.callSha256 === current.callSha256;
}

export function OperationsExecution({ task, proposal, decisionBusy }: {
  task: Pick<TaskDto, 'id' | 'runId' | 'version'>; proposal: Proposal; decisionBusy: boolean;
}) {
  const { api, locale } = usePortal();
  const t = useText();
  const restoring = proposal.kind === 'rollback';
  const path = `/v1/tasks/${task.id}/${restoring ? 'operations-restore' : 'operations-execution'}`;
  const query = useRemote<ExecutionView>(path, restoring ? operationsRestoreExecutionViewSchema : operationsRestartExecutionViewSchema,
    { localized: true, revision: task.version, poll: true });
  const view = !query.error && query.data?.taskId === task.id && query.data.runId === task.runId && query.data.locale === locale
    ? query.data : undefined;
  const result = view?.execution;
  const expectedRestore = !restoring || (result && 'restore' in result && result.restore.operationId === proposal.restore?.operationId
    && result.restore.manifestDigest === proposal.restore.manifestDigest);
  const receipt = expectedRestore && result?.proposalId === proposal.id && result.releaseOperationId === proposal.current.operationId ? result : null;
  const restoreReceipt = receipt && 'restore' in receipt ? receipt : null;
  const restartReceipt = receipt && 'nativeApprovalId' in receipt ? receipt : null;
  const verification = restoreReceipt?.recovery?.proof;
  const proofSha256 = verification?.proofSha256 ?? restartReceipt?.recovery?.proofSha256;
  let action = proposal.status === 'confirmed' ? view?.action ?? null : null;
  if (action?.kind === 'enqueue') {
    const decision = proposal.decisions.at(-1);
    if (result || action.proposalId !== proposal.id || action.fingerprint !== proposal.fingerprint
        || decision?.action !== 'confirm' || action.decisionVersion !== decision.version) action = null;
  }
  if (action?.kind === 'continue' && (restartReceipt?.state !== 'waiting_approval' || action.executionId !== restartReceipt.id
      || action.expectedVersion !== restartReceipt.taskVersion || action.approvalId !== restartReceipt.nativeApprovalId)) action = null;
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmation = pending && action && sameAction(pending.action, action) ? pending : null;
  const inFlight = useRef(false);
  useEffect(() => {
    if (pending && !confirmation) setPending(null);
  }, [pending, confirmation]);

  const submission = useMutation({
    retry: false, gcTime: 0,
    mutationFn: async ({ action: requested, idempotencyKey }: Pending) => {
      if (requested.kind === 'enqueue') {
        const { proposalId, fingerprint, decisionVersion } = requested;
        return api.request(`/v1/operations/proposals/${proposalId}/${restoring ? 'restore' : 'execution'}`, operationsSubmissionSchema, locale,
          { method: 'POST', body: { fingerprint, decisionVersion } });
      }
      const { executionId, approvalId, callSha256, expectedVersion } = requested;
      const response = await api.request(`/v1/operations/executions/${executionId}/continue`, operationsSubmissionSchema, locale,
        { method: 'POST', body: { approvalId, callSha256, expectedVersion, idempotencyKey } });
      if (response.executionId !== executionId) throw new ApiFailure('invalidResponse');
      return response;
    },
    onSuccess: () => setPending(null),
    onError: error => { if (error instanceof ApiFailure && error.code) setPending(null); },
    onSettled: async () => { await query.refetch(); inFlight.current = false; },
  });
  if (query.error) {
    if (query.error instanceof ApiFailure && (query.error.code === 'not_found' || query.error.code === 'forbidden')) return null;
    return <Failure error={query.error} locale={locale} retry={() => { void query.refetch(); }} />;
  }
  if (!action && !receipt) return null;
  const busy = decisionBusy || submission.isPending;
  const text = confirmation && (restoring ? restoreAction : actions[confirmation.action.kind]);
  return <div className="space-y-3 border-t border-border pt-3" data-testid={restoring ? 'operations-restore-execution' : 'operations-restart-execution'}>
    <h4 className="text-sm font-semibold">{t(restoring ? 'operationsRestoreExecution' : 'operationsRestartExecution')}</h4>
    {receipt && <>
      <p className="muted" role="status" aria-atomic="true">{receipt.message}</p>
      {restartReceipt?.nativeApprovalId && <dl className="detail-grid">
        <div><dt>{t('operationsNativeApproval')}</dt><dd><code className="break-text">{restartReceipt.nativeApprovalId}</code></dd></div>
      </dl>}
      <Disclosure title={t(restoring ? 'operationsRestoreReceipt' : 'operationsRestartReceipt')}>
        <dl className="detail-grid">
          <div><dt>{t('operationsExecutionId')}</dt><dd><code className="break-text">{receipt.id}</code></dd></div>
          <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{receipt.releaseOperationId}</code></dd></div>
          <div><dt>{t('operationsEnvironmentHold')}</dt><dd>{t(receipt.environmentHeld ? 'operationsEnvironmentHeld' : 'operationsEnvironmentReleased')}</dd></div>
          {restoreReceipt && <div><dt>{t('operationsRestoreRelease')}</dt><dd><code className="break-text">{restoreReceipt.restore.operationId}</code></dd></div>}
          {restoreReceipt?.nativeUpdateId && <div><dt>{t('operationsNativeUpdate')}</dt><dd><code className="break-text">{restoreReceipt.nativeUpdateId}</code></dd></div>}
          {verification && <>
            <div><dt>{t('operationsRestoredVersion')}</dt><dd>{verification.version}</dd></div>
            <div><dt>{t('operationsRestoreVerifiedAt')}</dt><dd><time dateTime={verification.verifiedAt}>{formatTime(verification.verifiedAt, locale)}</time></dd></div>
          </>}
          {proofSha256 && <div><dt>{t('operationsRecoveryProof')}</dt><dd><code className="break-text">{proofSha256}</code></dd></div>}
        </dl>
      </Disclosure>
    </>}
    {action && <Button type="button" variant="outline" disabled={busy} onClick={() => {
      submission.reset();
      setPending({ action, idempotencyKey: crypto.randomUUID() });
    }}>{t((restoring ? restoreAction : actions[action.kind]).label)}</Button>}
    {submission.error && !confirmation && <Failure error={submission.error} locale={locale} />}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !submission.isPending) setPending(null); }}>
      {confirmation && text && <DialogContent>
        <DialogTitle>{t(text.title)}</DialogTitle>
        <DialogDescription>{t(text.help)}</DialogDescription>
        <dl className="detail-grid mt-2">
          <div><dt>{t('operationsCurrentImage')}</dt><dd><code className="break-text">{proposal.current.manifestDigest}</code></dd></div>
          {restoring && proposal.restore && <div><dt>{t('operationsRestoreImage')}</dt><dd><code className="break-text">{proposal.restore.manifestDigest}</code></dd></div>}
          {confirmation.action.kind === 'continue' && <div><dt>{t('operationsNativeApproval')}</dt>
            <dd><code className="break-text">{confirmation.action.approvalId}</code></dd></div>}
        </dl>
        {submission.error && <Failure error={submission.error} locale={locale} />}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={submission.isPending} />}>{t('cancel')}</DialogClose>
          <Button type="button" disabled={busy} onClick={() => {
            if (inFlight.current || busy) return;
            inFlight.current = true;
            submission.mutate(confirmation);
          }}>{t(text.label)}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </div>;
}
