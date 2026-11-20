import { useEffect } from 'react';
import type { FormInstance } from 'antd';
import type { Locale, TaskState } from '@itervane/contracts';
import { ApiFailure, errorText } from './api.js';
import { ui, stateLabel } from './messages.js';
import { HeadingAccent } from './motion.js';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';

export function Loading({ locale }: { locale: Locale }) {
  return <div className="loading" role="status">
    <span className="size-5 animate-spin rounded-full border-2 border-solid border-border border-t-primary" aria-hidden="true" />
    <span>{ui(locale, 'loading')}</span>
  </div>;
}
export function Failure({ error, locale, retry }: { error: unknown; locale: Locale; retry?: () => void }) {
  return <Alert variant="destructive" role="alert">
    <AlertTitle>{ui(locale, 'errorTitle')}</AlertTitle>
    <AlertDescription>
      <p>{errorText(error, locale)}</p>
      {error instanceof ApiFailure && error.requestId && <p>{ui(locale, 'requestId')}: <code>{error.requestId}</code></p>}
    </AlertDescription>
    {retry && <Button variant="outline" className="mt-3" onClick={retry}>{ui(locale, 'retry')}</Button>}
  </Alert>;
}
export function Status({ state, locale }: { state: TaskState; locale: Locale }) {
  const variant = state === 'succeeded' ? 'success' : ['failed', 'needs_human'].includes(state) ? 'destructive'
    : ['waiting_input', 'waiting_approval', 'cancel_requested'].includes(state) ? 'warning' : state === 'running' ? 'info' : 'default';
  return <Badge variant={variant}>{stateLabel(locale, state)}</Badge>;
}
export function PageHeading({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return <div className="page-heading"><div className="heading-copy"><HeadingAccent /><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>;
}
export function Panel({ title, actions, children, ...props }: React.ComponentProps<typeof Card> & { title: string; actions?: React.ReactNode }) {
  return <Card {...props}>
    <CardHeader><CardTitle>{title}</CardTitle>{actions}</CardHeader>
    <CardContent>{children}</CardContent>
  </Card>;
}
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="empty-state"><strong>{title}</strong>{description && <p className="muted">{description}</p>}</div>;
}
export const formatTime = (value: string, locale: Locale) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export function useTranslatedValidation(form: FormInstance, locale: Locale) {
  useEffect(() => {
    const errors = form.getFieldsError().filter(field => field.errors.length).map(field => field.name);
    if (errors.length) void form.validateFields(errors).catch(() => {});
  }, [form, locale]);
}
