import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { operationsIncidentsViewSchema, operationsIncidentStopResultSchema, taskIncidentViewSchema,
  type OperationsIncidentSummary, type TaskDto } from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure, Panel, Status, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';

export function PublishedIncidentHistory({ projectId, environmentId, releaseOperationId }: {
  projectId: string; environmentId: string; releaseOperationId: string;
}) {
  const { locale } = usePortal();
  const t = useText();
  const path = `/v1/projects/${projectId}/environments/${environmentId}/operations-incidents`;
  const query = useRemote(path, operationsIncidentsViewSchema, { localized: true, poll: true });
  if (query.error) return query.error instanceof ApiFailure && query.error.code === 'not_found' ? null
    : <Failure error={query.error} locale={locale} retry={() => { void query.refetch(); }} />;
  const view = query.data;
  if (view?.projectId !== projectId || view.environmentId !== environmentId || view.locale !== locale) return null;
  const health = view.latestHealth?.releaseOperationId === releaseOperationId ? view.latestHealth : null;
  const incidents = view.items.filter(incident => incident.releaseOperationId === releaseOperationId);
  if (!health && incidents.length === 0) return null;
  return <section className="mt-4 space-y-3 border-t border-border pt-3" data-testid="release-health-history">
    {health && <div>
      <h3 className="text-sm font-semibold">{t('incidentHealth')}</h3>
      <p role="status">{health.message}</p>
      <time className="muted text-sm" dateTime={health.recordedAt}>{formatTime(health.recordedAt, locale)}</time>
    </div>}
    {incidents.length > 0 && <Disclosure title={t('incidentHistory')}>
      <ul className="space-y-4">
        {incidents.map(incident => <li key={incident.id}><IncidentDetails incident={incident} /></li>)}
      </ul>
    </Disclosure>}
  </section>;
}

type StopDraft = { path: string; incidentId: string; releaseOperationId: string; restoreExecutionId: string | null };

export function TaskIncident({ task }: { task: Pick<TaskDto, 'id' | 'projectId' | 'version'> }) {
  const { api, locale } = usePortal();
  const t = useText();
  const query = useRemote(`/v1/tasks/${task.id}/operations-incident`, taskIncidentViewSchema, { localized: true, revision: task.version, poll: true });
  const [pending, setPending] = useState<StopDraft | null>(null);
  const view = !query.error && query.data?.taskId === task.id && query.data.locale === locale ? query.data : undefined;
  const incident = view?.incident;
  const scope = view?.stopDiagnosis;
  const draft = incident && scope?.projectId === task.projectId ? {
    path: `/v1/projects/${scope.projectId}/environments/${scope.environmentId}/operations-incidents/${incident.id}/stop-diagnosis`,
    incidentId: incident.id, releaseOperationId: incident.releaseOperationId, restoreExecutionId: incident.restoreExecutionId,
  } : null;
  const confirmation = pending && draft?.path === pending.path && draft.releaseOperationId === pending.releaseOperationId
    && draft.restoreExecutionId === pending.restoreExecutionId ? pending : null;
  useEffect(() => { if (!confirmation) setPending(null); }, [confirmation]);
  const refresh = () => { void query.refetch(); };
  const stop = useMutation({ retry: false,
    mutationFn: async (input: StopDraft) => {
      const result = await api.request(input.path, operationsIncidentStopResultSchema, locale, { method: 'POST', body: {
        expectedReleaseOperationId: input.releaseOperationId, expectedRestoreExecutionId: input.restoreExecutionId,
      } });
      if (result.incidentId !== input.incidentId) throw new ApiFailure('invalidResponse');
      return result;
    },
    onSuccess: () => setPending(null),
    onError: error => { if (error instanceof ApiFailure && error.code) setPending(null); },
    onSettled: () => query.refetch(),
  });
  if (query.error) return query.error instanceof ApiFailure && query.error.code === 'not_found' ? null
    : <Failure error={query.error} locale={locale} retry={refresh} />;
  if (!incident) return null;
  return <Panel title={t('incidentRecord')} className="section-gap" data-testid="task-health-incident">
    <IncidentDetails incident={incident} />
    {draft && <Button type="button" className="mt-3" variant="outline" disabled={stop.isPending} onClick={() => {
      stop.reset(); setPending(draft);
    }}>{t('incidentStopDiagnosis')}</Button>}
    {stop.error && !confirmation && <Failure error={stop.error} locale={locale} />}
    <Dialog open={confirmation !== null} disablePointerDismissal onOpenChange={(open, event) => {
      if (open) return;
      if (stop.isPending) event.cancel(); else setPending(null);
    }}>
      {confirmation && <DialogContent aria-busy={stop.isPending}>
        <DialogTitle>{t('incidentStopTitle')}</DialogTitle>
        <DialogDescription>{t('incidentStopHelp')}</DialogDescription>
        <dl className="detail-grid">
          <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{confirmation.releaseOperationId}</code></dd></div>
          {confirmation.restoreExecutionId && <div><dt>{t('operationsRestoreExecution')}</dt>
            <dd><code className="break-text">{confirmation.restoreExecutionId}</code></dd></div>}
        </dl>
        {stop.error && <Failure error={stop.error} locale={locale} />}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={stop.isPending} />}>{t('cancel')}</DialogClose>
          <Button type="button" disabled={stop.isPending} onClick={() => stop.mutate(confirmation)}>{t('incidentStopDiagnosis')}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </Panel>;
}

function IncidentDetails({ incident }: { incident: OperationsIncidentSummary }) {
  const { locale } = usePortal();
  const t = useText();
  const activeRepairs = incident.repairs.filter(repair => repair.taskId !== null);
  const numbers = new Intl.NumberFormat(locale);
  return <div className="space-y-2">
    <div role="status" aria-atomic="true">
      <p>{incident.message}</p>
      <p className="muted">{incident.latestSample.message}</p>
      {incident.diagnosisStop && <p>{incident.diagnosisStop.message}</p>}
    </div>
    <dl className="detail-grid">
      <div><dt>{t('incidentOpened')}</dt><dd><time dateTime={incident.openedAt}>{formatTime(incident.openedAt, locale)}</time></dd></div>
      <div><dt>{t('incidentLatestSample')}</dt><dd><time dateTime={incident.latestSample.recordedAt}>
        {formatTime(incident.latestSample.recordedAt, locale)}</time></dd></div>
      <div><dt>{t('incidentFailures')}</dt><dd>{numbers.format(incident.unhealthySamples)}</dd></div>
      {incident.closedAt && <div><dt>{t('incidentClosed')}</dt><dd><time dateTime={incident.closedAt}>{formatTime(incident.closedAt, locale)}</time></dd></div>}
    </dl>
    {(incident.diagnoses.length > 0 || activeRepairs.length > 0) && <ul className="space-y-1" aria-label={t('incidentRelatedTasks')}>
      {incident.diagnoses.map(diagnosis => <li className="flex flex-wrap items-center gap-2 text-sm" key={diagnosis.taskId}>
        <a className="nav-link" href={`#/tasks/${diagnosis.taskId}`}>{t('incidentDiagnosisTask')} {numbers.format(diagnosis.attempt)}</a>
        <Status state={diagnosis.state} locale={locale} />
      </li>)}
      {activeRepairs.map(repair => <li className="flex flex-wrap items-center gap-2 text-sm" key={repair.proposalId}>
        <a className="nav-link" href={`#/tasks/${repair.taskId}`}>{t('incidentRepairTask')}</a>
        {repair.state && <Status state={repair.state} locale={locale} />}
      </li>)}
    </ul>}
  </div>;
}
