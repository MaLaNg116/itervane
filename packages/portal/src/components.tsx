import { useEffect } from 'react';
import { Alert, Button, Spin, Tag, Typography, type FormInstance } from 'antd';
import type { Locale, TaskState } from '@itervane/contracts';
import { ApiFailure, errorText } from './api.js';
import { ui, stateLabel } from './messages.js';

export function Loading({ locale }: { locale: Locale }) { return <div className="loading" role="status"><Spin /><span>{ui(locale, 'loading')}</span></div>; }
export function Failure({ error, locale, retry }: { error: unknown; locale: Locale; retry?: () => void }) {
  return <Alert type="error" showIcon title={ui(locale, 'errorTitle')} description={<>
    <p role="alert">{errorText(error, locale)}</p>
    {error instanceof ApiFailure && error.requestId && <p className="muted">{ui(locale, 'requestId')}: <code>{error.requestId}</code></p>}
    {retry && <Button onClick={retry}>{ui(locale, 'retry')}</Button>}
  </>} />;
}
export function Status({ state, locale }: { state: TaskState; locale: Locale }) {
  const color = state === 'succeeded' ? 'success' : ['failed', 'needs_human'].includes(state) ? 'error'
    : ['waiting_input', 'waiting_approval', 'cancel_requested'].includes(state) ? 'warning' : state === 'running' ? 'processing' : 'default';
  return <Tag color={color}>{stateLabel(locale, state)}</Tag>;
}
export function PageHeading({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return <div className="page-heading"><div className="heading-copy"><Typography.Title level={1}>{title}</Typography.Title>{description && <p className="muted">{description}</p>}</div><div className="actions">{actions}</div></div>;
}
export const formatTime = (value: string, locale: Locale) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export function useTranslatedValidation(form: FormInstance, locale: Locale) {
  useEffect(() => {
    const errors = form.getFieldsError().filter(field => field.errors.length).map(field => field.name);
    if (errors.length) void form.validateFields(errors).catch(() => {});
  }, [form, locale]);
}
