import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { projectAccessDtoSchema, sourceInspectionDtoSchema, taskDtoSchema, taskEventDtoSchema } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { Failure, Loading, PageHeading, Panel, Status, formatTime } from '../components.js';
import { ApiFailure } from '../api.js';
import { StateMarker, useNewEventMotion } from '../motion.js';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';

export function TaskPage({ id }: { id: string }) {
  const { locale } = usePortal();
  const task = useRemote(`/v1/tasks/${id}`, taskDtoSchema, { poll: true });
  if (task.isPending) return <Loading locale={locale} />;
  if (task.error) return <Failure error={task.error} locale={locale} retry={() => { void task.refetch(); }} />;
  return <TaskContent task={task.data} />;
}

function TaskContent({ task }: { task: z.infer<typeof taskDtoSchema> }) {
  const { api, locale } = usePortal(); const t = useText(); const cache = useQueryClient();
  const access = useRemote(`/v1/projects/${task.projectId}/access`, projectAccessDtoSchema, { poll: true });
  const events = useRemote(`/v1/tasks/${task.id}/events?limit=100`, z.object({ items: taskEventDtoSchema.array() }).strict(), { poll: true, localized: true });
  const inspection = useRemote(`/v1/tasks/${task.id}/source-inspection`, sourceInspectionDtoSchema, { poll: true });
  const [confirmation, setConfirmation] = useState<{ action: 'cancel' | 'resume'; expectedVersion: number } | null>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const canWrite = access.data?.canWrite === true && !access.error;
  useEffect(() => { if (!canWrite) setConfirmation(null); }, [canWrite]);
  const control = useMutation({ retry: false,
    mutationFn: (input: NonNullable<typeof confirmation>) => api.request(`/v1/tasks/${task.id}/${input.action}`, taskDtoSchema, locale, { method: 'POST', body: { expectedVersion: input.expectedVersion } }),
    onSettled: () => { inFlight.current = false; setConfirmation(null); void cache.invalidateQueries(); },
  });
  const canCancel = ['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.state);
  const canResume = task.state === 'waiting_input' && events.data?.items.at(-1)?.reason === 'runner_unavailable';
  if (access.error) return <Failure error={access.error} locale={locale} />;
  const cancelling = confirmation?.action === 'cancel';
  return <>
    <a href={`#/projects/${task.projectId}`} className="back-link">← {t('tasks')}</a>
    <PageHeading title={t('taskDetails')} actions={<>
      {canWrite && canResume && <Button variant="outline" disabled={control.isPending} onClick={() => setConfirmation({ action: 'resume', expectedVersion: task.version })}>{t('resumeTask')}</Button>}
      {canWrite && canCancel && <Button variant="destructive" disabled={control.isPending} onClick={() => setConfirmation({ action: 'cancel', expectedVersion: task.version })}>{t('cancelTask')}</Button>}
    </>} />
    {control.error && <div className="section-gap">{control.error instanceof ApiFailure && control.error.code === 'version_conflict'
      ? <Alert variant="warning" role="alert"><AlertTitle>{t('controlConflict')}</AlertTitle></Alert> : <Failure error={control.error} locale={locale} />}</div>}
    {canResume && <Alert className="section-gap" variant="warning"><AlertTitle>{t('preflightOnly')}</AlertTitle><AlertDescription>{t('runnerNotice')}</AlertDescription></Alert>}
    <section className="task-state-panel section-gap" aria-label={t('latestState')}>
      <div className="task-current-state" role="status" aria-atomic="true"><StateMarker value={task.state} /><div><p className="muted">{t('latestState')}</p><Status state={task.state} locale={locale} /></div></div>
      <div><p className="muted">{t('dataClass')}</p><strong>{t(task.dataClass === 'public' ? 'publicData' : 'synthetic')}</strong></div>
      <div><p className="muted">{t('taskLanguage')}</p><strong data-testid="task-locale">{t(task.locale === 'en' ? 'english' : 'chinese')}</strong></div>
    </section>
    <Panel title={t('taskRecord')} className="section-gap">
      <p className="task-purpose">{task.purpose}</p>
      <dl className="detail-grid">
        <div><dt>{t('taskId')}</dt><dd><code>{task.id}</code></dd></div>
        <div><dt>{t('createdAt')}</dt><dd>{formatTime(task.createdAt, locale)}</dd></div>
        <div><dt>{t('runId')}</dt><dd><code>{task.runId}</code></dd></div>
        <div><dt>{t('version')}</dt><dd>{task.version}</dd></div>
        <div><dt>{t('source')}</dt><dd><code className="break-text">{task.source.commit}</code></dd></div>
      </dl>
      <p className="muted">{t('taskLanguageHint')}</p>
    </Panel>
    <div className="task-evidence">
    <Panel title={t('events')}>
      <p className="muted activity-hint">{t('activityHint')}</p>
      {events.isPending ? <Loading locale={locale} /> : events.error ? <Failure error={events.error} locale={locale} retry={() => { void events.refetch(); }} />
        : events.data.items.length ? <ActivityTimeline items={events.data.items} /> : <p className="muted">{t('emptyEvents')}</p>}
    </Panel>
    <Panel title={t('inspection')} data-testid="source-inspection">
      {inspection.isPending ? <Loading locale={locale} /> : inspection.error ? <Failure error={inspection.error} locale={locale} retry={() => { void inspection.refetch(); }} /> : <>
        <Badge variant="warning">{t(inspection.data.status === 'blocked' ? 'inspectionBlocked' : 'inspectionPending')}</Badge>
        <p>{t('inspectionBoundary')}</p>
        <dl className="detail-grid"><div><dt>{t('requestedCommit')}</dt><dd><code>{inspection.data.requestedSource.commit}</code></dd></div>
          <div><dt>{t('requiredIsolation')}</dt><dd>{t('disposableVm')}</dd></div>
          {inspection.data.plan && <div><dt>{t('planDigest')}</dt><dd><code>{inspection.data.plan.sha256}</code></dd></div>}</dl>
        {inspection.data.plan && <><h3>{t('scannerProfiles')}</h3><ul>{inspection.data.plan.document.scanners.map(profile => <li key={profile.scanner}>{profile.scanner} {profile.version}</li>)}</ul></>}
        <p className="muted">{t('scannerCoverage')}</p>
      </>}
    </Panel>
    </div>
    {canWrite && <Dialog open={confirmation !== null} disablePointerDismissal onOpenChange={(open, event) => {
      if (open) return;
      if (inFlight.current) event.cancel();
      else setConfirmation(null);
    }}>
      <DialogContent initialFocus={returnButton} aria-busy={control.isPending}>
        <DialogTitle>{t(cancelling ? 'cancelTitle' : 'resumeTitle')}</DialogTitle>
        <DialogDescription>{t(cancelling ? 'cancelHelp' : 'resumeHelp')}</DialogDescription>
        <DialogFooter>
          <DialogClose disabled={control.isPending} render={<Button ref={returnButton} variant="outline" />}>{t('cancel')}</DialogClose>
          <Button variant={cancelling ? 'destructive' : 'default'} disabled={control.isPending} onClick={() => {
            if (!confirmation || inFlight.current) return;
            inFlight.current = true;
            // The version is the one shown when the user opened the confirmation.
            control.mutate(confirmation);
          }}>{t(cancelling ? 'confirmCancel' : 'confirmResume')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </>;
}

function ActivityTimeline({ items }: { items: z.infer<typeof taskEventDtoSchema>[] }) {
  const { locale } = usePortal(); const t = useText(); const scope = useNewEventMotion(items.map(event => event.sequence));
  return <ol className="event-list" ref={scope}>{items.map(event => <li key={event.sequence}>
    <span className="event-index" data-event-sequence={event.sequence} aria-hidden="true">{event.sequence}</span>
    <div><p className="event-title">{event.message}</p>{event.reasonMessage && <p className="muted">{event.reasonMessage}</p>}
      <div className="event-meta"><time dateTime={event.createdAt}>{formatTime(event.createdAt, locale)}</time><Badge>{t(event.actorKind === 'worker' ? 'worker' : 'principal')}</Badge></div>
    </div>
  </li>)}</ol>;
}
