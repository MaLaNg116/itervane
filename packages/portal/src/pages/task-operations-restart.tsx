import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { operationsRestartExecutionViewSchema, operationsRestartSubmissionSchema, type OperationsProposalView,
  type OperationsRestartExecutionView, type TaskDto } from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';

type Proposal = NonNullable<OperationsProposalView['proposal']>;
type RestartAction = NonNullable<OperationsRestartExecutionView['action']>;
type Pending = { action: RestartAction; idempotencyKey: string };
const actions = {
  enqueue: { label: 'operationsQueueRestart', title: 'operationsQueueRestartTitle', help: 'operationsQueueRestartHelp' },
  continue: { label: 'operationsContinueRestart', title: 'operationsContinueRestartTitle', help: 'operationsContinueRestartHelp' },
} as const;

function sameAction(saved: RestartAction, current: RestartAction) {
  if (saved.kind === 'enqueue' && current.kind === 'enqueue') {
    return saved.proposalId === current.proposalId && saved.fingerprint === current.fingerprint && saved.decisionVersion === current.decisionVersion;
  }
  return saved.kind === 'continue' && current.kind === 'continue' && saved.executionId === current.executionId
    && saved.expectedVersion === current.expectedVersion && saved.approvalId === current.approvalId && saved.callSha256 === current.callSha256;
}

export function OperationsRestartExecution({ task, proposal, decisionBusy }: {
  task: Pick<TaskDto, 'id' | 'runId' | 'version'>; proposal: Proposal; decisionBusy: boolean;
}) {
  const { api, locale } = usePortal();
  const t = useText();
  const path = `/v1/tasks/${task.id}/operations-execution`;
  const query = useRemote(path, operationsRestartExecutionViewSchema, { localized: true, revision: task.version, poll: true });
  const view = !query.error && query.data?.taskId === task.id && query.data.runId === task.runId && query.data.locale === locale
    ? query.data : undefined;
  const result = view?.execution;
  const receipt = result?.proposalId === proposal.id && result.releaseOperationId === proposal.current.operationId ? result : null;
  let action = proposal.status === 'confirmed' ? view?.action ?? null : null;
  if (action?.kind === 'enqueue') {
    const decision = proposal.decisions.at(-1);
    if (result || action.proposalId !== proposal.id || action.fingerprint !== proposal.fingerprint
        || decision?.action !== 'confirm' || action.decisionVersion !== decision.version) action = null;
  }
  if (action?.kind === 'continue' && (receipt?.state !== 'waiting_approval' || action.executionId !== receipt.id
      || action.expectedVersion !== receipt.taskVersion || action.approvalId !== receipt.nativeApprovalId)) action = null;
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
        return api.request(`/v1/operations/proposals/${proposalId}/execution`, operationsRestartSubmissionSchema, locale,
          { method: 'POST', body: { fingerprint, decisionVersion } });
      }
      const { executionId, approvalId, callSha256, expectedVersion } = requested;
      const response = await api.request(`/v1/operations/executions/${executionId}/continue`, operationsRestartSubmissionSchema, locale,
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
  const text = confirmation && actions[confirmation.action.kind];
  return <div className="space-y-3 border-t border-border pt-3" data-testid="operations-restart-execution">
    <h4 className="text-sm font-semibold">{t('operationsRestartExecution')}</h4>
    {receipt && <>
      <p className="muted" role="status" aria-atomic="true">{receipt.message}</p>
      {receipt.nativeApprovalId && <dl className="detail-grid">
        <div><dt>{t('operationsNativeApproval')}</dt><dd><code className="break-text">{receipt.nativeApprovalId}</code></dd></div>
      </dl>}
      <Disclosure title={t('operationsRestartReceipt')}>
        <dl className="detail-grid">
          <div><dt>{t('operationsExecutionId')}</dt><dd><code className="break-text">{receipt.id}</code></dd></div>
          <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{receipt.releaseOperationId}</code></dd></div>
          <div><dt>{t('operationsEnvironmentHold')}</dt><dd>{t(receipt.environmentHeld ? 'operationsEnvironmentHeld' : 'operationsEnvironmentReleased')}</dd></div>
          {receipt.recovery?.proofSha256 && <div><dt>{t('operationsRecoveryProof')}</dt>
            <dd><code className="break-text">{receipt.recovery.proofSha256}</code></dd></div>}
        </dl>
      </Disclosure>
    </>}
    {action && <Button type="button" variant="outline" disabled={busy} onClick={() => {
      submission.reset();
      setPending({ action, idempotencyKey: crypto.randomUUID() });
    }}>{t(actions[action.kind].label)}</Button>}
    {submission.error && !confirmation && <Failure error={submission.error} locale={locale} />}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !submission.isPending) setPending(null); }}>
      {confirmation && text && <DialogContent>
        <DialogTitle>{t(text.title)}</DialogTitle>
        <DialogDescription>{t(text.help)}</DialogDescription>
        <dl className="detail-grid mt-2">
          <div><dt>{t('operationsCurrentImage')}</dt><dd><code className="break-text">{proposal.current.manifestDigest}</code></dd></div>
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
