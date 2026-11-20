import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Form, Input, Modal, Select, Table, Tag } from 'antd';
import { z } from 'zod';
import { admissionDtoSchema, projectDtoSchema, projectAccessDtoSchema, repositoryDtoSchema, repositoryInputSchema, startTaskSchema, taskDtoSchema, type Locale } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { Failure, Loading, PageHeading, Status, formatTime, useTranslatedValidation } from '../components.js';
import { navigate } from '../router.js';

const repositoriesSchema = z.object({ items: repositoryDtoSchema.array() }).strict();
export function ProjectPage({ id }: { id: string }) {
  const { locale } = usePortal(); const t = useText();
  const project = useRemote(`/v1/projects/${id}`, projectDtoSchema);
  const access = useRemote(`/v1/projects/${id}/access`, projectAccessDtoSchema, { poll: true });
  const repositories = useRemote(`/v1/projects/${id}/repositories?limit=100`, repositoriesSchema);
  const tasks = useRemote(`/v1/projects/${id}/tasks?limit=100`, z.object({ items: taskDtoSchema.array() }).strict(), { poll: true });
  const [dialog, setDialog] = useState<'repository' | 'task' | null>(null);
  if (project.isPending || access.isPending || repositories.isPending || tasks.isPending) return <Loading locale={locale} />;
  const error = project.error ?? access.error ?? repositories.error ?? tasks.error;
  if (error) return <Failure error={error} locale={locale} retry={() => { void project.refetch(); void access.refetch(); void repositories.refetch(); void tasks.refetch(); }} />;
  if (!project.data || !access.data || !repositories.data || !tasks.data) return null;
  return <>
    <a href="#/projects" className="back-link">← {t('backProjects')}</a>
    <PageHeading title={project.data.name} description={t('taskHint')} actions={<>
      <Tag>{t(access.data.role)}</Tag><Button href={`#/projects/${id}/preaudit`}>{t('rulesPreaudit')}</Button><Button onClick={() => { void tasks.refetch(); }}>{t('refresh')}</Button>
      {access.data.canWrite && <Button type="primary" disabled={!repositories.data.items.length} onClick={() => setDialog('task')}>{t('startTask')}</Button>}
    </>} />
    <Alert className="section-gap" type="info" showIcon title={t('preflightOnly')} description={t('runnerNotice')} />
    <Card className="section-gap">
      <Table rowKey="id" dataSource={tasks.data.items} pagination={false} scroll={{ x: 680 }} locale={{ emptyText: <Empty description={t('emptyTasks')} /> }} columns={[
        { title: t('purpose'), key: 'purpose', render: (_: unknown, task: z.infer<typeof taskDtoSchema>) => <a href={`#/tasks/${task.id}`}>{task.purpose}</a> },
        { title: t('status'), key: 'state', render: (_: unknown, task: z.infer<typeof taskDtoSchema>) => <Status state={task.state} locale={locale} /> },
        { title: t('source'), key: 'commit', render: (_: unknown, task: z.infer<typeof taskDtoSchema>) => <code title={task.source.commit}>{task.source.commit.slice(0, 10)}</code> },
        { title: t('createdAt'), dataIndex: 'createdAt', render: (value: string) => formatTime(value, locale) },
      ]} />
      {tasks.data.items.length === 100 && <p className="muted">{t('shownLimit')}</p>}
    </Card>
    <Card title={t('repositories')} extra={access.data.canWrite && <Button onClick={() => setDialog('repository')}>{t('addRepository')}</Button>}>
      <p className="muted">{t('repositoryHint')}</p>
      {repositories.data.items.length === 0 ? <Empty description={<>{t('emptyRepositories')}<p>{t('emptyRepositoriesHelp')}</p></>} />
        : <ul className="repository-list">{repositories.data.items.map(repository => <li key={repository.id}><strong>{repository.name}</strong><span className="muted break-text">{repository.url}</span></li>)}</ul>}
    </Card>
    <Modal open={dialog === 'repository'} onCancel={() => setDialog(null)} footer={null} title={t('addRepository')} destroyOnHidden>
      <RepositoryForm projectId={id} onComplete={() => setDialog(null)} />
    </Modal>
    <Modal open={dialog === 'task'} onCancel={() => setDialog(null)} footer={null} title={t('startTask')} destroyOnHidden>
      <TaskForm projectId={id} repositories={repositories.data.items} />
    </Modal>
  </>;
}

function RepositoryForm({ projectId, onComplete }: { projectId: string; onComplete: () => void }) {
  const { api, locale } = usePortal(); const t = useText(); const cache = useQueryClient(); const [form] = Form.useForm();
  useTranslatedValidation(form, locale);
  const mutation = useMutation({ retry: false, mutationFn: (values: unknown) => api.request(`/v1/projects/${projectId}/repositories`, repositoryDtoSchema, locale,
    { method: 'POST', body: repositoryInputSchema.parse(values) }), onSuccess: () => { void cache.invalidateQueries(); onComplete(); } });
  return <Form form={form} layout="vertical" onFinish={values => mutation.mutate(values)} disabled={mutation.isPending}>
    <Form.Item name="name" label={t('repositoryName')} rules={[{ required: true, whitespace: true, message: t('required') }, { max: 120, message: t('tooLong') }]}><Input autoFocus maxLength={120} /></Form.Item>
    <Form.Item name="url" label={t('repositoryUrl')} rules={[{ required: true, message: t('required') }, { validator: async (_rule, value: unknown) => {
      if (!repositoryInputSchema.shape.url.safeParse(value).success) throw new Error(t('invalidUrl'));
    } }]}><Input autoCapitalize="none" maxLength={2048} placeholder="https://example.com/team/app.git" /></Form.Item>
    {mutation.error && <Failure error={mutation.error} locale={locale} />}
    <Button type="primary" htmlType="submit" loading={mutation.isPending}>{t('saveRepository')}</Button>
  </Form>;
}

function TaskForm({ projectId, repositories }: { projectId: string; repositories: z.infer<typeof repositoryDtoSchema>[] }) {
  const { api, locale } = usePortal(); const t = useText(); const [form] = Form.useForm();
  const [attempt, setAttempt] = useState<z.infer<typeof startTaskSchema> | null>(null);
  const attemptRef = useRef<z.infer<typeof startTaskSchema> | null>(null);
  useTranslatedValidation(form, locale);
  const mutation = useMutation({ retry: false, mutationFn: (input: z.infer<typeof startTaskSchema>) => api.request('/v1/tasks', admissionDtoSchema, locale, { method: 'POST', body: input }),
    onSuccess: result => navigate(`#/tasks/${result.task.id}`) });
  function submit(values: { repositoryId: string; commit: string; purpose: string; dataClass: 'synthetic' | 'public'; locale: Locale }) {
    const input = attemptRef.current ?? startTaskSchema.parse({ projectId, source: { repositoryId: values.repositoryId, commit: values.commit },
      purpose: values.purpose, dataClass: values.dataClass, locale: values.locale, idempotencyKey: crypto.randomUUID() });
    attemptRef.current = input; setAttempt(input); mutation.mutate(input);
  }
  return <Form form={form} layout="vertical" onFinish={submit} initialValues={{ dataClass: 'synthetic', locale, repositoryId: repositories[0]?.id }} disabled={mutation.isPending || Boolean(attempt)}>
    <Form.Item name="repositoryId" label={t('repository')} rules={[{ required: true, message: t('required') }]}><Select options={repositories.map(repository => ({ value: repository.id, label: repository.name }))} /></Form.Item>
    <Form.Item name="commit" label={t('commit')} extra={t('commitHint')} rules={[{ required: true, message: t('required') }, { pattern: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, message: t('invalidCommit') }]}><Input autoCapitalize="none" maxLength={64} /></Form.Item>
    <Form.Item name="purpose" label={t('purpose')} rules={[{ required: true, whitespace: true, message: t('required') }, { max: 2000, message: t('tooLong') }]}><Input.TextArea rows={3} maxLength={2000} /></Form.Item>
    <div className="form-columns"><Form.Item name="locale" label={t('taskLanguage')}><Select options={[{ value: 'en', label: t('english') }, { value: 'zh-CN', label: t('chinese') }]} /></Form.Item>
      <Form.Item name="dataClass" label={t('dataClass')}><Select options={[{ value: 'synthetic', label: t('synthetic') }, { value: 'public', label: t('publicData') }]} /></Form.Item></div>
    <p className="muted">{t('dataHint')}</p>
    {mutation.error && <><Failure error={mutation.error} locale={locale} /><Alert type="warning" title={t('unknownSubmission')} /></>}
    {attempt && mutation.error ? <Button type="primary" disabled={false} loading={mutation.isPending} onClick={() => mutation.mutate(attempt)}>{t('retrySubmission')}</Button>
      : <Button type="primary" htmlType="submit" disabled={false} loading={mutation.isPending}>{t('submitTask')}</Button>}
  </Form>;
}
