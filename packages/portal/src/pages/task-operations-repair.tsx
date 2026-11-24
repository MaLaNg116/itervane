import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { admissionDtoSchema, operationsRepairViewSchema, sourceRefSchema, type TaskDto } from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure, Status, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/fields.js';

type PendingRepair = { id: string; fingerprint: string; commitInput: string };
type Approval = { id: string; fingerprint: string; source: TaskDto['source']; commit?: string };

export function OperationsRepair({ task }: { task: Pick<TaskDto, 'id' | 'projectId' | 'runId' | 'version'> }) {
  const { api, locale } = usePortal();
  const t = useText();
  const path = `/v1/tasks/${task.id}/operations-repair`;
  const query = useRemote(path, operationsRepairViewSchema, { localized: true, revision: task.version, poll: true });
  const [pending, setPending] = useState<PendingRepair | null>(null);
  const view = !query.error && query.data?.taskId === task.id && query.data.runId === task.runId
    && query.data.taskVersion === task.version && query.data.locale === locale ? query.data : undefined;
  const proposal = view?.proposal;
  const active = pending && proposal?.mayConfirm && proposal.id === pending.id && proposal.fingerprint === pending.fingerprint ? proposal : null;
  useEffect(() => { if (!active) setPending(null); }, [active]);
  const input = pending?.commitInput.trim() ?? '';
  const readyCommit = !active?.source.requiresMaterializedCommit || (input !== active.source.commit && sourceRefSchema.shape.commit.safeParse(input).success);
  const refresh = () => query.refetch();
  const prepare = useMutation({ retry: false,
    mutationFn: (diagnosisSha256: string) => api.request(path, operationsRepairViewSchema, locale, { method: 'POST', body: { diagnosisSha256 } }),
    onSettled: refresh,
  });
  const confirm = useMutation({ retry: false,
    mutationFn: async ({ id, fingerprint, source, commit }: Approval) => {
      const { task: linked } = await api.request(`/v1/operations/repair-proposals/${id}/confirm`, admissionDtoSchema, locale, {
        method: 'POST', body: { fingerprint, locale, ...(commit ? { commit } : {}) },
      });
      if (linked.projectId !== task.projectId || linked.workflow === 'operations' || linked.source.repositoryId !== source.repositoryId
          || linked.source.commit !== (commit ?? source.commit)) throw new ApiFailure('invalidResponse');
      return linked;
    },
    onSuccess: () => setPending(null),
    onError: error => { if (error instanceof ApiFailure && error.code) setPending(null); },
    onSettled: refresh,
  });
  if (query.error) return query.error instanceof ApiFailure && query.error.code === 'not_found' ? null
    : <Failure error={query.error} locale={locale} retry={() => { void refresh(); }} />;
  const draft = view?.draft;
  if (!draft && !proposal) return null;
  const busy = prepare.isPending || confirm.isPending;
  const error = prepare.error ?? confirm.error;
  return <section className="space-y-3 border-t border-border pt-3" data-testid="operations-linked-repair">
    <h3 className="text-sm font-semibold">{t('linkedRepair')}</h3>
    {draft && <Button type="button" variant="outline" disabled={busy} onClick={() => prepare.mutate(draft.diagnosisSha256)}>
      {t('linkedRepairPrepare')}
    </Button>}
    {proposal && <>
      <p role="status">{proposal.message}</p>
      <dl className="detail-grid">
        <div><dt>{t('source')}</dt><dd><code className="break-text">{proposal.source.commit}</code></dd></div>
        <div><dt>{t('releaseDeadline')}</dt><dd><time dateTime={proposal.validUntil}>{formatTime(proposal.validUntil, locale)}</time></dd></div>
      </dl>
      <Disclosure title={t('operationsProposalDigest')}><code className="break-text">{proposal.fingerprint}</code></Disclosure>
      {proposal.linkedTask && <div className="flex flex-wrap items-center gap-2">
        <a className="nav-link" href={`#/tasks/${proposal.linkedTask.taskId}`}>{t('incidentRepairTask')}</a>
        <Status state={proposal.linkedTask.state} locale={locale} />
      </div>}
      {proposal.mayConfirm && <Button type="button" disabled={busy} onClick={() => {
        confirm.reset(); setPending({ id: proposal.id, fingerprint: proposal.fingerprint, commitInput: '' });
      }}>{t('linkedRepairConfirm')}</Button>}
    </>}
    {error && !active && <Failure error={error} locale={locale} />}
    <Dialog open={!!active} disablePointerDismissal onOpenChange={(open, event) => {
      if (open) return;
      if (confirm.isPending) event.cancel(); else setPending(null);
    }}>
      {active && pending && <DialogContent aria-busy={confirm.isPending}>
        <DialogTitle>{t('linkedRepairConfirmTitle')}</DialogTitle>
        <DialogDescription>{t('linkedRepairConfirmHelp')}</DialogDescription>
        <dl className="detail-grid">
          <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{active.target.releaseOperationId}</code></dd></div>
          {active.target.restoreExecutionId && <div><dt>{t('operationsRestoreExecution')}</dt>
            <dd><code className="break-text">{active.target.restoreExecutionId}</code></dd></div>}
          <div><dt>{t('source')}</dt><dd><code className="break-text">{active.source.commit}</code></dd></div>
        </dl>
        {active.source.requiresMaterializedCommit && <div className="space-y-2 text-sm">
          <label htmlFor="linked-repair-commit">{t('linkedRepairMaterializedCommit')}</label>
          <Input id="linked-repair-commit" autoComplete="off" spellCheck={false} disabled={confirm.isPending} aria-describedby="linked-repair-commit-help"
            value={pending.commitInput} onChange={event => setPending({ ...pending, commitInput: event.target.value })} />
          <p className="muted" id="linked-repair-commit-help">{t('linkedRepairCommitHelp')}</p>
        </div>}
        {confirm.error && <Failure error={confirm.error} locale={locale} />}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={confirm.isPending} />}>{t('cancel')}</DialogClose>
          <Button type="button" disabled={!readyCommit || confirm.isPending} onClick={() => confirm.mutate({
            id: active.id, fingerprint: active.fingerprint, source: active.source,
            ...(active.source.requiresMaterializedCommit ? { commit: input } : {}),
          })}>{t('linkedRepairConfirm')}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </section>;
}
