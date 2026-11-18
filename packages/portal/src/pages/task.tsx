import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Modal, Tag } from 'antd';
import { z } from 'zod';
import { projectAccessDtoSchema, taskDtoSchema, taskEventDtoSchema } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { Failure, Loading, PageHeading, Status, formatTime } from '../components.js';
import { ApiFailure } from '../api.js';

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
  const [confirmation, setConfirmation] = useState<{ action: 'cancel' | 'resume'; expectedVersion: number } | null>(null);
  const control = useMutation({ retry: false,
    mutationFn: (input: NonNullable<typeof confirmation>) => api.request(`/v1/tasks/${task.id}/${input.action}`, taskDtoSchema, locale, { method: 'POST', body: { expectedVersion: input.expectedVersion } }),
    onSettled: () => { setConfirmation(null); void cache.invalidateQueries(); },
  });
  const canCancel = ['queued', 'running', 'waiting_input', 'waiting_approval'].includes(task.state);
  const canResume = task.state === 'waiting_input' && events.data?.items.at(-1)?.reason === 'runner_unavailable';
  if (access.error) return <Failure error={access.error} locale={locale} />;
  return <>
    <a href={`#/projects/${task.projectId}`} className="back-link">← {t('tasks')}</a>
    <PageHeading title={t('taskDetails')} actions={<>
      <Status state={task.state} locale={locale} />
      {access.data?.canWrite && canResume && <Button disabled={control.isPending} onClick={() => setConfirmation({ action: 'resume', expectedVersion: task.version })}>{t('resumeTask')}</Button>}
      {access.data?.canWrite && canCancel && <Button danger disabled={control.isPending} onClick={() => setConfirmation({ action: 'cancel', expectedVersion: task.version })}>{t('cancelTask')}</Button>}
    </>} />
    {control.error && <div className="section-gap">{control.error instanceof ApiFailure && control.error.code === 'version_conflict'
      ? <Alert type="warning" showIcon title={t('controlConflict')} /> : <Failure error={control.error} locale={locale} />}</div>}
    {canResume && <Alert className="section-gap" type="warning" showIcon title={t('preflightOnly')} description={t('runnerNotice')} />}
    <Card className="section-gap">
      <h2 className="task-purpose">{task.purpose}</h2>
      <dl className="detail-grid">
        <div><dt>{t('taskId')}</dt><dd><code>{task.id}</code></dd></div>
        <div><dt>{t('createdAt')}</dt><dd>{formatTime(task.createdAt, locale)}</dd></div>
        <div><dt>{t('runId')}</dt><dd><code>{task.runId}</code></dd></div>
        <div><dt>{t('version')}</dt><dd>{task.version}</dd></div>
        <div><dt>{t('source')}</dt><dd><code className="break-text">{task.source.commit}</code></dd></div>
        <div><dt>{t('dataClass')}</dt><dd>{t(task.dataClass === 'public' ? 'publicData' : 'synthetic')}</dd></div>
        <div><dt>{t('taskLanguage')}</dt><dd data-testid="task-locale">{t(task.locale === 'en' ? 'english' : 'chinese')}</dd></div>
      </dl>
      <p className="muted">{t('taskLanguageHint')}</p>
    </Card>
    <Card title={t('events')}>
      {events.isPending ? <Loading locale={locale} /> : events.error ? <Failure error={events.error} locale={locale} retry={() => { void events.refetch(); }} />
        : <ol className="event-list">{events.data.items.map(event => <li key={event.sequence}>
          <span className="event-index" aria-hidden="true">{event.sequence}</span>
          <div><p className="event-title">{event.message}</p>{event.reasonMessage && <p className="muted">{event.reasonMessage}</p>}
            <div className="event-meta"><time dateTime={event.createdAt}>{formatTime(event.createdAt, locale)}</time><Tag>{t(event.actorKind === 'worker' ? 'worker' : 'principal')}</Tag></div>
          </div>
        </li>)}</ol>}
    </Card>
    <Modal open={confirmation !== null} title={t(confirmation?.action === 'cancel' ? 'cancelTitle' : 'resumeTitle')}
      okText={t(confirmation?.action === 'cancel' ? 'confirmCancel' : 'confirmResume')} cancelText={t('cancel')}
      confirmLoading={control.isPending} closable={!control.isPending} maskClosable={!control.isPending}
      cancelButtonProps={{ disabled: control.isPending }} onCancel={() => setConfirmation(null)}
      onOk={() => { if (confirmation && !control.isPending) control.mutate(confirmation); }}>
      <p>{t(confirmation?.action === 'cancel' ? 'cancelHelp' : 'resumeHelp')}</p>
    </Modal>
  </>;
}
