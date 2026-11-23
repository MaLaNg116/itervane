import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { eventReasonMessages, projectAccessDtoSchema, retrySourceInspectionReasonSchema, sourceInspectionDtoSchema,
  taskDtoSchema, taskEventDtoSchema, translate, type SourceInspectionDto } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { Failure, Loading, PageHeading, Panel, Status, formatTime } from '../components.js';
import { ApiFailure } from '../api.js';
import { StateMarker, useNewEventMotion } from '../motion.js';
import { Alert, AlertTitle } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { TaskAudit } from './task-audit.js';
import { TaskRepair } from './task-repair.js';
import { TaskVerification } from './task-verification.js';
import { TaskRelease } from './task-release.js';
import { TaskOperations } from './task-operations.js';
import { TaskIncident } from './task-incidents.js';

const controlText = {
  cancel: { title: 'cancelTitle', help: 'cancelHelp', confirm: 'confirmCancel' },
  retry: { title: 'resumeTitle', help: 'resumeHelp', confirm: 'confirmResume' },
  audit: { title: 'continueAuditTitle', help: 'continueAuditHelp', confirm: 'continueAudit' },
  repair: { title: 'continueRepairTitle', help: 'continueRepairHelp', confirm: 'continueRepair' },
} as const;

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
  const operations = task.workflow === 'operations';
  const [confirmation, setConfirmation] = useState<{ action: keyof typeof controlText; expectedVersion: number } | null>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const canWrite = access.data?.canWrite === true && !access.error;
  useEffect(() => { if (!canWrite) setConfirmation(null); }, [canWrite]);
  const control = useMutation({ retry: false,
    mutationFn: (input: NonNullable<typeof confirmation>) => api.request(`/v1/tasks/${task.id}/${input.action === 'cancel' ? 'cancel' : 'resume'}`,
      taskDtoSchema, locale, { method: 'POST', body: { expectedVersion: input.expectedVersion } }),
    onSettled: () => { inFlight.current = false; setConfirmation(null); void cache.invalidateQueries(); },
  });
  const canCancel = ['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.state);
  const waitReason = events.error ? undefined : events.data?.items.at(-1)?.reason;
  const canResume = task.state === 'waiting_input' && retrySourceInspectionReasonSchema.safeParse(waitReason).success;
  const canStartAudit = task.state === 'waiting_input' && waitReason === 'inspection_ready';
  if (access.error) return <Failure error={access.error} locale={locale} />;
  const cancelling = confirmation?.action === 'cancel';
  const dialog = controlText[confirmation?.action ?? 'retry'];
  return <>
    <a href={`#/projects/${task.projectId}`} className="back-link">← {t('tasks')}</a>
    <PageHeading title={t('taskDetails')} actions={<>
      {canWrite && canResume && <Button variant="outline" disabled={control.isPending} onClick={() => setConfirmation({ action: 'retry', expectedVersion: task.version })}>{t('resumeTask')}</Button>}
      {canWrite && canStartAudit && <Button variant="outline" disabled={control.isPending} onClick={() => setConfirmation({ action: 'audit', expectedVersion: task.version })}>{t('continueAudit')}</Button>}
      {canWrite && canCancel && <Button variant="destructive" disabled={control.isPending} onClick={() => setConfirmation({ action: 'cancel', expectedVersion: task.version })}>{t('cancelTask')}</Button>}
    </>} />
    {control.error && <div className="section-gap">{control.error instanceof ApiFailure && control.error.code === 'version_conflict'
      ? <Alert variant="warning" role="alert"><AlertTitle>{t('controlConflict')}</AlertTitle></Alert> : <Failure error={control.error} locale={locale} />}</div>}
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
    {operations ? <TaskOperations task={task} /> : <TaskInspection taskId={task.id} />}
    </div>
    <TaskIncident key={task.id} task={task} />
    {!operations && <>
      <TaskAudit taskId={task.id} />
      <TaskRepair taskId={task.id} canWrite={canWrite} disabled={control.isPending}
        onResume={() => setConfirmation({ action: 'repair', expectedVersion: task.version })} />
      <TaskVerification taskId={task.id} runId={task.runId} revision={task.version} />
      <TaskRelease task={task} canWrite={canWrite} />
    </>}
    {canWrite && <Dialog open={confirmation !== null} disablePointerDismissal onOpenChange={(open, event) => {
      if (open) return;
      if (inFlight.current) event.cancel();
      else setConfirmation(null);
    }}>
      <DialogContent initialFocus={returnButton} aria-busy={control.isPending}>
        <DialogTitle>{t(dialog.title)}</DialogTitle>
        <DialogDescription>{t(dialog.help)}</DialogDescription>
        <DialogFooter>
          <DialogClose disabled={control.isPending} render={<Button ref={returnButton} variant="outline" />}>{t('cancel')}</DialogClose>
          <Button variant={cancelling ? 'destructive' : 'default'} disabled={control.isPending} onClick={() => {
            if (!confirmation || inFlight.current) return;
            inFlight.current = true;
            // The version is the one shown when the user opened the confirmation.
            control.mutate(confirmation);
          }}>{t(dialog.confirm)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </>;
}

const inspectionStatus = {
  not_prepared: { label: 'inspectionPending', variant: 'default' }, blocked: { label: 'inspectionBlocked', variant: 'warning' },
  checking: { label: 'inspectionChecking', variant: 'info' }, reconciling: { label: 'inspectionReconciling', variant: 'warning' },
  completed: { label: 'inspectionCompleted', variant: 'success' }, incomplete: { label: 'inspectionIncomplete', variant: 'warning' },
} as const;
const scanStatus = { completed: 'scanCompleted', failed: 'scanFailed', unavailable: 'scanUnavailable', unsupported: 'scanUnsupported' } as const;
const scanReason = { timeout: 'scanTimeout', scanner_error: 'scanError', invalid_report: 'scanInvalid', missing_inventory: 'scanNoInventory',
  database_unavailable: 'scanNoDatabase', empty_source: 'scanEmptySource' } as const;

function TaskInspection({ taskId }: { taskId: string }) {
  const { locale } = usePortal(); const t = useText();
  const inspection = useRemote(`/v1/tasks/${taskId}/source-inspection`, sourceInspectionDtoSchema, { poll: true });
  return <Panel title={t('inspection')} data-testid="source-inspection">
    {inspection.isPending ? <Loading locale={locale} /> : inspection.error ? <Failure error={inspection.error} locale={locale} retry={() => { void inspection.refetch(); }} />
      : <InspectionDetails inspection={inspection.data} />}
  </Panel>;
}

function InspectionDetails({ inspection }: { inspection: SourceInspectionDto }) {
  const { locale } = usePortal(); const t = useText();
  const state = inspectionStatus[inspection.status];
  const result = 'result' in inspection ? inspection.result : undefined;
  return <>
    <Badge variant={state.variant}>{t(state.label)}</Badge>
    {inspection.status !== 'not_prepared' && inspection.reason && <p>{translate(locale, eventReasonMessages[inspection.reason])}</p>}
    <dl className="detail-grid">
      <div><dt>{t('requestedCommit')}</dt><dd><code className="break-text">{inspection.requestedSource.commit}</code></dd></div>
      <div><dt>{t('requiredIsolation')}</dt><dd>{t('disposableVm')}</dd></div>
      {inspection.plan && <div><dt>{t('planDigest')}</dt><dd><code className="break-text">{inspection.plan.sha256}</code></dd></div>}
      {result && <>
        <div><dt>{t('snapshotDigest')}</dt><dd><code className="break-text">{result.snapshotSha256}</code></dd></div>
        <div><dt>{t('inspectionReceipt')}</dt><dd><code className="break-text">{result.receiptSha256}</code></dd></div>
      </>}
    </dl>
    {inspection.plan && <>
      <h3>{t('scannerProfiles')}</h3>
      <ul>{inspection.plan.document.scanners.map((profile, index) => {
        const scan = result?.scans[index];
        return <li key={profile.scanner} className="py-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{profile.scanner} {profile.version}</strong>
            {scan && <Badge variant={scan.status === 'completed' ? 'success' : 'warning'}>{t(scanStatus[scan.status])}</Badge>}
            {scan?.status === 'completed' && <span className="muted">{t('scanFindings')} {scan.findingsCount}</span>}
          </div>
          {scan?.reason && <p className="muted">{t(scanReason[scan.reason])}</p>}
        </li>;
      })}</ul>
    </>}
    <p className="muted">{t('scannerCoverage')}</p>
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
