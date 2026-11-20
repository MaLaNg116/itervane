import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Empty, Form, Input, Modal, Tag } from 'antd';
import { z } from 'zod';
import { projectDtoSchema, projectInputSchema } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { Failure, Loading, PageHeading, useTranslatedValidation } from '../components.js';
import { navigate } from '../router.js';

export function ProjectsPage() {
  const { locale, me } = usePortal(); const t = useText();
  const projects = useRemote('/v1/projects?limit=100', z.object({ items: projectDtoSchema.array() }).strict());
  const [creating, setCreating] = useState(false);
  return <>
    <PageHeading title={t('projects')} description={t('projectsHint')} actions={<>
      <Button onClick={() => { void projects.refetch(); }}>{t('refresh')}</Button>
      {me.isWorkspaceOwner && <Button type="primary" onClick={() => setCreating(true)}>{t('createProject')}</Button>}
    </>} />
    {projects.isPending ? <Loading locale={locale} /> : projects.error ? <Failure error={projects.error} locale={locale} retry={() => { void projects.refetch(); }} />
      : projects.data.items.length === 0 ? <Card><Empty description={<><strong>{t('emptyProjects')}</strong><p>{t(me.isWorkspaceOwner ? 'emptyProjectsHelp' : 'readOnly')}</p></>} /></Card>
      : <div className="project-grid">{projects.data.items.map(project => <Card key={project.id}>
        <div className="project-card-top"><span className="project-monogram" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span><Tag>{project.slug}</Tag></div>
        <h2><a href={`#/projects/${project.id}`}>{project.name}</a></h2>
        <p className="muted">{t('repositories')} · {t('tasks')}</p>
      </Card>)}</div>}
    {projects.data?.items.length === 100 && <p className="muted">{t('shownLimit')}</p>}
    <Modal open={creating} onCancel={() => setCreating(false)} footer={null} title={t('createProject')} destroyOnHidden>
      <CreateProject onComplete={id => { setCreating(false); navigate(`#/projects/${id}`); }} />
    </Modal>
  </>;
}

function CreateProject({ onComplete }: { onComplete: (id: string) => void }) {
  const { api, locale } = usePortal(); const t = useText(); const cache = useQueryClient(); const [form] = Form.useForm();
  useTranslatedValidation(form, locale);
  const mutation = useMutation({ retry: false, mutationFn: (values: unknown) => api.request('/v1/projects', projectDtoSchema, locale,
    { method: 'POST', body: projectInputSchema.parse(values) }), onSuccess: project => { void cache.invalidateQueries(); onComplete(project.id); } });
  return <Form form={form} layout="vertical" onFinish={values => mutation.mutate(values)} disabled={mutation.isPending}>
    <Form.Item name="name" label={t('projectName')} rules={[{ required: true, whitespace: true, message: t('required') }, { max: 120, message: t('tooLong') }]}><Input autoFocus maxLength={120} /></Form.Item>
    <Form.Item name="slug" label={t('projectSlug')} extra={t('slugHint')} rules={[{ required: true, message: t('required') }, { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: t('invalidSlug') }, { max: 64, message: t('tooLong') }]}><Input maxLength={64} autoCapitalize="none" /></Form.Item>
    {mutation.error && <Failure error={mutation.error} locale={locale} />}
    <Button type="primary" htmlType="submit" loading={mutation.isPending}>{t('createProject')}</Button>
  </Form>;
}
