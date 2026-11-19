import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Card, Empty, Form, Input, Select, Table, Tag } from 'antd';
import { z } from 'zod';
import { catalogDtoSchema, limitedTextSchema, preauditAdmissionSchema, preauditInputSchema, preauditSummaryDtoSchema, projectAccessDtoSchema, projectDtoSchema, type PreauditInput } from '@itervane/contracts';
import { usePortal, useRemote, useText } from '../context.js';
import { Failure, Loading, PageHeading, formatTime, useTranslatedValidation } from '../components.js';
import { navigate } from '../router.js';

export function PreauditPage({ id }: { id: string }) {
  const { locale } = usePortal(); const t = useText();
  const project = useRemote(`/v1/projects/${id}`, projectDtoSchema);
  const access = useRemote(`/v1/projects/${id}/access`, projectAccessDtoSchema, { poll: true });
  const catalog = useRemote(`/v1/projects/${id}/rules`, catalogDtoSchema, { localized: true });
  const history = useRemote(`/v1/projects/${id}/preaudits?limit=100`, z.object({ items: preauditSummaryDtoSchema.array() }).strict());
  const refresh = () => { void project.refetch(); void access.refetch(); void catalog.refetch(); void history.refetch(); };
  if (project.isPending || access.isPending || catalog.isPending || history.isPending) return <Loading locale={locale} />;
  const error = project.error ?? access.error ?? catalog.error ?? history.error;
  if (error) return <Failure error={error} locale={locale} retry={refresh} />;
  if (!project.data || !access.data || !catalog.data || !history.data) return null;
  return <>
    <a href={`#/projects/${id}`} className="back-link">← {t('backProjects')}</a>
    <PageHeading title={t('rulesPreaudit')} description={project.data.name} actions={<Button onClick={refresh}>{t('refreshRules')}</Button>} />
    <Alert className="section-gap" type="info" showIcon title={t('preauditBoundary')} />
    <Card title={t('preauditNew')} className="section-gap">
      {access.data.canWrite ? <PreauditForm projectId={id} catalogSha256={catalog.data.sha256} /> : <p>{t('readOnly')}</p>}
    </Card>
    <Card title={t('rules')} className="section-gap">
      <p className="muted">{t('catalogVersion')}: {catalog.data.version} · {t('engineVersion')}: {catalog.data.engineVersion} · {t('advisory')}</p>
      <code className="break-text">{catalog.data.sha256}</code>
      {catalog.data.items.map(rule => <section key={rule.id} className="rule-material" data-testid={`rule-${rule.id}`}>
        <h3>{rule.title} <Tag>{t(rule.kind === 'check' ? 'ruleCheck' : rule.kind === 'skill' ? 'ruleSkill' : 'ruleGuidance')}</Tag></h3>
        <p>{rule.guidance}</p><p className="muted">{rule.limitation}</p>
        <p className="muted"><code>{rule.id}</code> · {rule.version} · {rule.source.license} · {rule.languages.join(', ')}</p>
        {rule.source.references.map(reference => <p key={reference} className="muted break-text"><a href={reference} target="_blank" rel="noreferrer noopener">{reference}</a></p>)}
      </section>)}
    </Card>
    <Card title={t('preauditHistory')}>
      <Table rowKey="id" dataSource={history.data.items} pagination={false} scroll={{ x: 620 }} locale={{ emptyText: <Empty description={t('emptyPreaudits')} /> }} columns={[
        { title: t('reportId'), key: 'id', render: (_: unknown, value: z.infer<typeof preauditSummaryDtoSchema>) => <a href={`#/preaudits/${value.id}`}>{value.id.slice(0, 8)}</a> },
        { title: t('status'), key: 'outcome', render: (_: unknown, value: z.infer<typeof preauditSummaryDtoSchema>) => t(`outcome_${value.outcome}`) },
        { title: t('codeLanguage'), key: 'language', render: (_: unknown, value: z.infer<typeof preauditSummaryDtoSchema>) => value.input.language },
        { title: t('createdAt'), dataIndex: 'createdAt', render: (value: string) => formatTime(value, locale) },
      ]} />
      {history.data.items.length === 100 && <p className="muted">{t('shownLimit')}</p>}
    </Card>
  </>;
}

function PreauditForm({ projectId, catalogSha256 }: { projectId: string; catalogSha256: string }) {
  const { api, locale } = usePortal(); const t = useText(); const [form] = Form.useForm();
  const attempt = useRef<PreauditInput | null>(null); const pending = useRef(false); const [locked, setLocked] = useState(false);
  useTranslatedValidation(form, locale);
  // Source remains in component/request memory, never in mutation variables or a query key.
  const mutation = useMutation({ retry: false, gcTime: 0, mutationFn: () => {
    if (!attempt.current) throw new Error('missing_preaudit_attempt');
    return api.request('/v1/preaudits', preauditAdmissionSchema, locale, { method: 'POST', body: attempt.current });
  }, onSuccess: result => { attempt.current = null; form.resetFields(); navigate(`#/preaudits/${result.report.id}`); }, onSettled: () => { pending.current = false; } });
  function submit(values: { language: string; format: string; dataClass: string; text: string }) {
    if (pending.current) return;
    attempt.current ??= preauditInputSchema.parse({ projectId, catalogSha256, idempotencyKey: crypto.randomUUID(), ...values });
    pending.current = true; setLocked(true); mutation.mutate();
  }
  return <Form form={form} layout="vertical" initialValues={{ language: 'typescript', format: 'snippet', dataClass: 'synthetic' }} disabled={locked || mutation.isPending} onFinish={submit}>
    <p className="muted">{t('preauditPrivacy')}</p>
    <div className="form-columns"><Form.Item name="language" label={t('codeLanguage')}><Select options={['typescript', 'javascript', 'json', 'text'].map(value => ({ value, label: value }))} /></Form.Item>
      <Form.Item name="format" label={t('inputFormat')}><Select virtual={false} options={[{ value: 'snippet', label: t('snippet') }, { value: 'unified_diff', label: t('unifiedDiff') }]} /></Form.Item></div>
    <Form.Item name="dataClass" label={t('dataClass')}><Select virtual={false} options={[{ value: 'synthetic', label: t('synthetic') }, { value: 'public', label: t('publicData') }]} /></Form.Item>
    <Form.Item name="text" label={t('preauditText')} extra={t('preauditLimits')} rules={[{ validator: async (_rule, value: unknown) => {
      if (!limitedTextSchema.safeParse(value).success) throw new Error(t('invalidPreauditText'));
    } }]}><Input.TextArea rows={9} maxLength={16384} autoComplete="off" autoCapitalize="none" spellCheck={false} /></Form.Item>
    {mutation.error && <><Failure error={mutation.error} locale={locale} /><Alert className="section-gap" type="warning" title={t('unknownSubmission')} /></>}
    <div className="actions">
      <Button type="primary" htmlType={locked ? 'button' : 'submit'} disabled={false} loading={mutation.isPending} onClick={locked ? () => { if (!pending.current) { pending.current = true; mutation.mutate(); } } : undefined}>{t(locked ? 'retrySubmission' : 'runPreaudit')}</Button>
      {locked && mutation.error && <Button disabled={false} onClick={() => { attempt.current = null; setLocked(false); form.resetFields(); mutation.reset(); }}>{t('resetPreaudit')}</Button>}
    </div>
  </Form>;
}
