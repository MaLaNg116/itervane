import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { projectDtoSchema, projectInputSchema, type ProjectInput } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { EmptyState, Failure, Loading, PageHeading } from '../components.js';
import { FormDialog, FormError, FormField, useFormValidation } from '../forms.js';
import { navigate } from '../router.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card } from '../ui/card.js';
import { Input } from '../ui/fields.js';

export function ProjectsPage() {
  const { locale, me } = usePortal(); const t = useText();
  const projects = useRemote('/v1/projects?limit=100', z.object({ items: projectDtoSchema.array() }).strict());
  return <>
    <PageHeading title={t('projects')} description={t('projectsHint')} actions={<>
      <Button variant="outline" onClick={() => { void projects.refetch(); }}>{t('refresh')}</Button>
      {me.isWorkspaceOwner && <CreateProject />}
    </>} />
    {projects.isPending ? <Loading locale={locale} /> : projects.error ? <Failure error={projects.error} locale={locale} retry={() => { void projects.refetch(); }} />
      : projects.data.items.length === 0 ? <Card><EmptyState title={t('emptyProjects')} description={t(me.isWorkspaceOwner ? 'emptyProjectsHelp' : 'readOnly')} /></Card>
      : <div className="project-index">{projects.data.items.map(project => <article className="project-entry" key={project.id}>
        <span className="project-monogram" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
        <div className="project-entry-copy"><h2><a href={`#/projects/${project.id}`}>{project.name}</a></h2><p className="muted">{t('projectContents')}</p></div>
        <Badge>{project.slug}</Badge>
      </article>)}</div>}
    {projects.data?.items.length === 100 && <p className="muted">{t('shownLimit')}</p>}
  </>;
}

function CreateProject() {
  const { api, locale } = usePortal(); const t = useText(); const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const validation = useFormValidation();
  const mutation = useMutation({ retry: false, mutationFn: (input: ProjectInput) => api.request('/v1/projects', projectDtoSchema, locale,
    { method: 'POST', body: input }), onSuccess: project => { void cache.invalidateQueries(); setOpen(false); navigate(`#/projects/${project.id}`); } });
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    const form = event.currentTarget;
    const input = validation.validate(form, projectInputSchema.safeParse(Object.fromEntries(new FormData(form))), { name: 'required', slug: 'invalidSlug' });
    if (input) mutation.mutate(input);
  }
  return <FormDialog title={t('createProject')} trigger={<Button>{t('createProject')}</Button>} open={open} pending={mutation.isPending}
    setOpen={next => { if (next) { validation.reset(); mutation.reset(); } setOpen(next); }}>
    <form className="form-stack" noValidate onSubmit={submit}>
      <fieldset className="form-stack" disabled={mutation.isPending}>
        <FormField label={t('projectName')} issue={validation.issues.name}>{attributes => <Input {...attributes} name="name" required maxLength={120} />}</FormField>
        <FormField label={t('projectSlug')} hint={t('slugHint')} issue={validation.issues.slug}>{attributes => <Input {...attributes} name="slug" required maxLength={64} autoCapitalize="none" />}</FormField>
      </fieldset>
      <FormError issue={validation.issues.form} />
      {mutation.error && <Failure error={mutation.error} locale={locale} />}
      <Button className="justify-self-start" type="submit" disabled={mutation.isPending}>{t('createProject')}</Button>
    </form>
  </FormDialog>;
}
