import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  admissionDtoSchema, projectDtoSchema, projectAccessDtoSchema, repositoryDtoSchema, repositoryInputSchema,
  startTaskSchema, taskDtoSchema, type RepositoryInput, type StartTask,
} from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { EmptyState, Failure, Loading, PageHeading, Panel, Status, formatTime } from '../components.js';
import { FormDialog, FormError, FormField, useFormValidation } from '../forms.js';
import { navigate } from '../router.js';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Input, NativeSelect, Textarea } from '../ui/fields.js';
import { Table } from '../ui/table.js';

const repositoriesSchema = z.object({ items: repositoryDtoSchema.array() }).strict();
const taskFormSchema = startTaskSchema.extend({ purpose: startTaskSchema.shape.purpose.refine(value => value.trim().length > 0) });

export function ProjectPage({ id }: { id: string }) {
  const { locale } = usePortal(); const t = useText();
  const project = useRemote(`/v1/projects/${id}`, projectDtoSchema);
  const access = useRemote(`/v1/projects/${id}/access`, projectAccessDtoSchema, { poll: true });
  const repositories = useRemote(`/v1/projects/${id}/repositories?limit=100`, repositoriesSchema);
  const tasks = useRemote(`/v1/projects/${id}/tasks?limit=100`, z.object({ items: taskDtoSchema.array() }).strict(), { poll: true });
  if (project.isPending || access.isPending || repositories.isPending || tasks.isPending) return <Loading locale={locale} />;
  const error = project.error ?? access.error ?? repositories.error ?? tasks.error;
  if (error) return <Failure error={error} locale={locale} retry={() => { void project.refetch(); void access.refetch(); void repositories.refetch(); void tasks.refetch(); }} />;
  if (!project.data || !access.data || !repositories.data || !tasks.data) return null;
  const canWrite = access.data.canWrite;
  return <>
    <a href="#/projects" className="back-link">← {t('backProjects')}</a>
    <PageHeading title={project.data.name} description={t('taskHint')} actions={<>
      <Badge>{t(access.data.role)}</Badge>
      <a href={`#/projects/${id}/preaudit`} className={buttonVariants({ variant: 'outline' })}>{t('rulesPreaudit')}</a>
      <Button variant="outline" onClick={() => { void tasks.refetch(); }}>{t('refresh')}</Button>
      {canWrite && (repositories.data.items.length
        ? <StartTaskDialog projectId={id} repositories={repositories.data.items} />
        : <Button disabled>{t('startTask')}</Button>)}
    </>} />
    <Alert className="section-gap">
      <AlertTitle>{t('preflightOnly')}</AlertTitle>
      <AlertDescription>{t('runnerNotice')}</AlertDescription>
    </Alert>
    <Panel title={t('tasks')} className="section-gap">
      {tasks.data.items.length === 0 ? <EmptyState title={t('emptyTasks')} /> : <Table label={t('tasks')}>
        <thead><tr>
          <th scope="col">{t('purpose')}</th><th scope="col">{t('status')}</th><th scope="col">{t('source')}</th><th scope="col">{t('createdAt')}</th>
        </tr></thead>
        <tbody>{tasks.data.items.map(task => <tr key={task.id}>
          <td><a href={`#/tasks/${task.id}`}>{task.purpose}</a></td>
          <td><Status state={task.state} locale={locale} /></td>
          <td><code title={task.source.commit}>{task.source.commit.slice(0, 10)}</code></td>
          <td><time dateTime={task.createdAt}>{formatTime(task.createdAt, locale)}</time></td>
        </tr>)}</tbody>
      </Table>}
      {tasks.data.items.length === 100 && <p className="muted">{t('shownLimit')}</p>}
    </Panel>
    <Panel title={t('repositories')} actions={canWrite && <RepositoryDialog projectId={id} />}>
      <p className="muted">{t('repositoryHint')}</p>
      {repositories.data.items.length === 0
        ? <EmptyState title={t('emptyRepositories')} description={t('emptyRepositoriesHelp')} />
        : <ul className="repository-list">{repositories.data.items.map(repository => <li key={repository.id}><strong>{repository.name}</strong><span className="muted break-text">{repository.url}</span></li>)}</ul>}
    </Panel>
  </>;
}

function RepositoryDialog({ projectId }: { projectId: string }) {
  const { api, locale } = usePortal(); const t = useText(); const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const validation = useFormValidation();
  const mutation = useMutation({ retry: false, mutationFn: (input: RepositoryInput) => api.request(`/v1/projects/${projectId}/repositories`, repositoryDtoSchema, locale,
    { method: 'POST', body: input }), onSuccess: () => { void cache.invalidateQueries(); setOpen(false); } });
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    const form = event.currentTarget;
    const input = validation.validate(form, repositoryInputSchema.safeParse(Object.fromEntries(new FormData(form))), { name: 'required', url: 'invalidUrl' });
    if (input) mutation.mutate(input);
  }
  return <FormDialog title={t('addRepository')} trigger={<Button variant="outline">{t('addRepository')}</Button>} open={open}
    pending={mutation.isPending} setOpen={next => { if (next) { validation.reset(); mutation.reset(); } setOpen(next); }}>
    <form className="form-stack" noValidate onSubmit={submit}>
      <fieldset className="form-stack" disabled={mutation.isPending}>
        <FormField label={t('repositoryName')} issue={validation.issues.name}>{attributes => <Input {...attributes} name="name" required maxLength={120} />}</FormField>
        <FormField label={t('repositoryUrl')} issue={validation.issues.url}>{attributes =>
          <Input {...attributes} name="url" type="url" required autoCapitalize="none" maxLength={2048} placeholder="https://example.com/team/app.git" />
        }</FormField>
      </fieldset>
      <FormError issue={validation.issues.form} />
      {mutation.error && <Failure error={mutation.error} locale={locale} />}
      <Button type="submit" className="justify-self-start" disabled={mutation.isPending}>{t('saveRepository')}</Button>
    </form>
  </FormDialog>;
}

function StartTaskDialog({ projectId, repositories }: { projectId: string; repositories: z.infer<typeof repositoryDtoSchema>[] }) {
  const { api, locale } = usePortal(); const t = useText();
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const attempt = useRef<StartTask | null>(null);
  const inFlight = useRef(false);
  const validation = useFormValidation();
  const mutation = useMutation({ retry: false, mutationFn: (input: StartTask) => api.request('/v1/tasks', admissionDtoSchema, locale, { method: 'POST', body: input }),
    onSuccess: result => navigate(`#/tasks/${result.task.id}`), onSettled: () => { inFlight.current = false; } });

  function send(input: StartTask) {
    if (inFlight.current) return;
    inFlight.current = true;
    mutation.mutate(input);
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (attempt.current) return;
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const input = validation.validate(form, taskFormSchema.safeParse({
      projectId, source: { repositoryId: values.repositoryId, commit: values.commit },
      purpose: values.purpose, dataClass: values.dataClass, locale: values.locale, idempotencyKey: crypto.randomUUID(),
    }), { repositoryId: 'required', commit: 'invalidCommit', purpose: 'required', dataClass: 'required', locale: 'required' });
    if (!input) return;
    attempt.current = input;
    setLocked(true);
    send(input);
  }
  return <FormDialog title={t('startTask')} trigger={<Button>{t('startTask')}</Button>} open={open}
    pending={mutation.isPending} setOpen={next => {
      if (next) { attempt.current = null; setLocked(false); validation.reset(); mutation.reset(); }
      setOpen(next);
    }}>
    <form className="form-stack" noValidate onSubmit={submit}>
      <fieldset className="form-stack" disabled={locked || mutation.isPending}>
        <FormField label={t('repository')} issue={validation.issues.repositoryId}>{attributes =>
          <NativeSelect {...attributes} name="repositoryId" required defaultValue={repositories[0]?.id}>
            {repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name}</option>)}
          </NativeSelect>
        }</FormField>
        <FormField label={t('commit')} hint={t('commitHint')} issue={validation.issues.commit}>{attributes =>
          <Input {...attributes} name="commit" required maxLength={64} autoCapitalize="none" />
        }</FormField>
        <FormField label={t('purpose')} issue={validation.issues.purpose}>{attributes =>
          <Textarea {...attributes} name="purpose" required rows={3} maxLength={2000} />
        }</FormField>
        <div className="form-columns">
          <FormField label={t('taskLanguage')} issue={validation.issues.locale}>{attributes =>
            <NativeSelect {...attributes} name="locale" defaultValue={locale}>
              <option value="en">{t('english')}</option><option value="zh-CN">{t('chinese')}</option>
            </NativeSelect>
          }</FormField>
          <FormField label={t('dataClass')} issue={validation.issues.dataClass}>{attributes =>
            <NativeSelect {...attributes} name="dataClass" defaultValue="synthetic">
              <option value="synthetic">{t('synthetic')}</option><option value="public">{t('publicData')}</option>
            </NativeSelect>
          }</FormField>
        </div>
      </fieldset>
      <p className="muted m-0">{t('dataHint')}</p>
      <FormError issue={validation.issues.form} />
      {mutation.error && <>
        <Failure error={mutation.error} locale={locale} />
        <Alert variant="warning"><AlertTitle>{t('unknownSubmission')}</AlertTitle></Alert>
      </>}
      {locked && mutation.error
        ? <Button className="justify-self-start" disabled={mutation.isPending} onClick={() => { if (attempt.current) send(attempt.current); }}>{t('retrySubmission')}</Button>
        : <Button className="justify-self-start" type="submit" disabled={locked || mutation.isPending}>{t('submitTask')}</Button>}
    </form>
  </FormDialog>;
}
