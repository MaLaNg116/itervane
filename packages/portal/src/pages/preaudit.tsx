import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { catalogDtoSchema, preauditAdmissionSchema, preauditInputSchema, preauditSummaryDtoSchema, projectAccessDtoSchema, projectDtoSchema, type PreauditInput } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { EmptyState, Failure, Loading, PageHeading, Panel, formatTime } from '../components.js';
import { FormError, FormField, useFormValidation } from '../forms.js';
import { navigate } from '../router.js';
import { Alert, AlertTitle } from '../ui/alert.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { NativeSelect, Textarea } from '../ui/fields.js';
import { Table } from '../ui/table.js';

export function PreauditPage({ id }: { id: string }) {
  const { locale } = usePortal(); const t = useText();
  const project = useRemote(`/v1/projects/${id}`, projectDtoSchema);
  const access = useRemote(`/v1/projects/${id}/access`, projectAccessDtoSchema, { poll: true });
  const catalog = useRemote(`/v1/projects/${id}/rules`, catalogDtoSchema, { localized: true, keepOnLocaleChange: true });
  const history = useRemote(`/v1/projects/${id}/preaudits?limit=100`, z.object({ items: preauditSummaryDtoSchema.array() }).strict());
  const refresh = () => { void project.refetch(); void access.refetch(); void catalog.refetch(); void history.refetch(); };
  if (project.isPending || access.isPending || catalog.isPending || history.isPending) return <Loading locale={locale} />;
  const error = project.error ?? access.error ?? catalog.error ?? history.error;
  if (error) return <Failure error={error} locale={locale} retry={refresh} />;
  if (!project.data || !access.data || !catalog.data || !history.data) return null;
  return <>
    <a href={`#/projects/${id}`} className="back-link">← {t('backProjects')}</a>
    <PageHeading title={t('rulesPreaudit')} description={project.data.name} actions={<Button variant="outline" onClick={refresh}>{t('refreshRules')}</Button>} />
    <Alert className="section-gap"><AlertTitle>{t('preauditBoundary')}</AlertTitle></Alert>
    <Panel title={t('preauditNew')} className="section-gap">
      {access.data.canWrite ? <PreauditForm projectId={id} catalogSha256={catalog.data.sha256} /> : <p>{t('readOnly')}</p>}
    </Panel>
    <Panel title={t('rules')} className="section-gap" aria-busy={catalog.isPlaceholderData}>
      {catalog.isPlaceholderData ? <Loading locale={locale} /> : <>
        <p className="muted">{t('catalogVersion')}: {catalog.data.version} · {t('engineVersion')}: {catalog.data.engineVersion} · {t('advisory')}</p>
        <code className="break-text">{catalog.data.sha256}</code>
        {catalog.data.items.map(rule => <section key={rule.id} className="rule-material" data-testid={`rule-${rule.id}`}>
          <h3>{rule.title} <Badge>{t(rule.kind === 'check' ? 'ruleCheck' : rule.kind === 'skill' ? 'ruleSkill' : 'ruleGuidance')}</Badge></h3>
          <p>{rule.guidance}</p><p className="muted">{rule.limitation}</p>
          <p className="muted"><code>{rule.id}</code> · {rule.version} · {rule.source.license} · {rule.languages.join(', ')}</p>
          {rule.source.references.map(reference => <p key={reference} className="muted break-text"><a href={reference} target="_blank" rel="noreferrer noopener">{reference}</a></p>)}
        </section>)}
      </>}
    </Panel>
    <Panel title={t('preauditHistory')}>
      {history.data.items.length === 0 ? <EmptyState title={t('emptyPreaudits')} /> : <Table label={t('preauditHistory')}>
        <thead><tr>
          <th scope="col">{t('reportId')}</th><th scope="col">{t('status')}</th><th scope="col">{t('codeLanguage')}</th><th scope="col">{t('createdAt')}</th>
        </tr></thead>
        <tbody>{history.data.items.map(value => <tr key={value.id}>
          <td><a href={`#/preaudits/${value.id}`}>{value.id.slice(0, 8)}</a></td>
          <td>{t(`outcome_${value.outcome}`)}</td>
          <td>{value.input.language}</td>
          <td><time dateTime={value.createdAt}>{formatTime(value.createdAt, locale)}</time></td>
        </tr>)}</tbody>
      </Table>}
      {history.data.items.length === 100 && <p className="muted">{t('shownLimit')}</p>}
    </Panel>
  </>;
}

function PreauditForm({ projectId, catalogSha256 }: { projectId: string; catalogSha256: string }) {
  const { api, locale } = usePortal(); const t = useText();
  const formRef = useRef<HTMLFormElement>(null);
  const attempt = useRef<PreauditInput | null>(null);
  const pending = useRef(false);
  const [locked, setLocked] = useState(false);
  const validation = useFormValidation();
  // The submitted text stays in component/request memory. Mutation variables remain empty.
  const mutation = useMutation({ retry: false, gcTime: 0, mutationFn: () => {
    if (!attempt.current) throw new Error('missing_preaudit_attempt');
    return api.request('/v1/preaudits', preauditAdmissionSchema, locale, { method: 'POST', body: attempt.current });
  }, onSuccess: result => {
    attempt.current = null;
    formRef.current?.reset();
    navigate(`#/preaudits/${result.report.id}`);
  }, onSettled: () => { pending.current = false; } });

  function send() {
    if (pending.current || !attempt.current) return;
    pending.current = true;
    mutation.mutate();
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || pending.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const input = validation.validate(form, preauditInputSchema.safeParse({
      projectId, catalogSha256, idempotencyKey: crypto.randomUUID(),
      language: values.get('language'), format: values.get('format'), dataClass: values.get('dataClass'), text: values.get('text'),
    }), { language: 'required', format: 'required', dataClass: 'required', text: 'invalidPreauditText' });
    if (!input) return;
    attempt.current = input;
    setLocked(true);
    send();
  }
  function reset() {
    attempt.current = null;
    setLocked(false);
    formRef.current?.reset();
    validation.reset();
    mutation.reset();
  }
  return <form ref={formRef} className="form-stack" noValidate aria-busy={mutation.isPending} onSubmit={submit}>
    <p className="muted m-0">{t('preauditPrivacy')}</p>
    <fieldset className="form-stack" disabled={locked || mutation.isPending}>
      <div className="form-columns">
        <FormField label={t('codeLanguage')} issue={validation.issues.language}>{attributes =>
          <NativeSelect {...attributes} name="language" defaultValue="typescript">
            {['typescript', 'javascript', 'json', 'text'].map(value => <option key={value} value={value}>{value}</option>)}
          </NativeSelect>
        }</FormField>
        <FormField label={t('inputFormat')} issue={validation.issues.format}>{attributes =>
          <NativeSelect {...attributes} name="format" defaultValue="snippet">
            <option value="snippet">{t('snippet')}</option><option value="unified_diff">{t('unifiedDiff')}</option>
          </NativeSelect>
        }</FormField>
      </div>
      <FormField label={t('dataClass')} issue={validation.issues.dataClass}>{attributes =>
        <NativeSelect {...attributes} name="dataClass" defaultValue="synthetic">
          <option value="synthetic">{t('synthetic')}</option><option value="public">{t('publicData')}</option>
        </NativeSelect>
      }</FormField>
      <FormField label={t('preauditText')} hint={t('preauditLimits')} issue={validation.issues.text}>{attributes =>
        <Textarea {...attributes} name="text" required rows={9} maxLength={16384} autoComplete="off" autoCapitalize="none" spellCheck={false} />
      }</FormField>
    </fieldset>
    <FormError issue={validation.issues.form} />
    {mutation.error && <>
      <Failure error={mutation.error} locale={locale} />
      <Alert variant="warning"><AlertTitle>{t('unknownSubmission')}</AlertTitle></Alert>
    </>}
    <div className="actions">
      {locked && mutation.error
        ? <Button disabled={mutation.isPending} onClick={send}>{t('retrySubmission')}</Button>
        : <Button type="submit" disabled={locked || mutation.isPending}>{t('runPreaudit')}</Button>}
      {locked && mutation.error && <Button variant="outline" onClick={reset}>{t('resetPreaudit')}</Button>}
    </div>
  </form>;
}
