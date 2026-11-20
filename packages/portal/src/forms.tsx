import { useId, useState, type ReactElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { useText } from './context.js';
import type { UiKey } from './messages.js';
import { Button } from './ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog.js';

type Issues = Partial<Record<string, UiKey>>;

export function useFormValidation() {
  const [issues, setIssues] = useState<Issues>({});
  function validate<T>(form: HTMLFormElement, result: z.ZodSafeParseResult<T>, fieldMessages: Issues): T | undefined {
    if (result.success) {
      setIssues({});
      return result.data;
    }
    const values = new FormData(form);
    const next: Issues = {};
    for (const issue of result.error.issues) {
      const name = issue.path.at(-1);
      const message = typeof name === 'string' && Object.hasOwn(fieldMessages, name) ? fieldMessages[name] : undefined;
      if (typeof name !== 'string' || !message) {
        next.form = 'invalidResponse';
        continue;
      }
      next[name] ??= message === 'invalidPreauditText' ? message
        : !String(values.get(name) ?? '').trim() ? 'required'
        : issue.code === 'too_big' ? 'tooLong' : message;
    }
    setIssues(next);
    const first = Object.keys(next).find(name => name !== 'form');
    const control = first ? form.elements.namedItem(first) : null;
    if (control instanceof HTMLElement) control.focus();
  }
  // Store message keys so locale changes preserve both field values and validation feedback.
  return { issues, validate, reset: () => setIssues({}) };
}

type FieldAria = { id: string; 'aria-invalid': true | undefined; 'aria-describedby': string | undefined };

export function FormField({ label, hint, issue, children }: {
  label: string; hint?: string; issue?: UiKey | undefined; children: (props: FieldAria) => ReactNode;
}) {
  const id = useId(); const t = useText();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = issue ? `${id}-error` : undefined;
  const description = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return <div className="form-field">
    <label htmlFor={id}>{label}</label>
    {children({ id, 'aria-invalid': issue ? true : undefined, 'aria-describedby': description })}
    {hint && <p id={hintId} className="muted">{hint}</p>}
    {issue && <p id={errorId} className="form-error" role="alert">{t(issue)}</p>}
  </div>;
}

export function FormError({ issue }: { issue: UiKey | undefined }) {
  const t = useText();
  return issue ? <p className="form-error" role="alert">{t(issue)}</p> : null;
}

export function FormDialog({ trigger, title, open, setOpen, pending, children }: {
  trigger: ReactElement; title: string; open: boolean; setOpen: (open: boolean) => void; pending: boolean; children: ReactNode;
}) {
  const t = useText();
  return <Dialog open={open} disablePointerDismissal onOpenChange={(next, event) => {
    if (!next && pending) event.cancel();
    else setOpen(next);
  }}>
    <DialogTrigger render={trigger} />
    <DialogContent aria-busy={pending}>
      <DialogTitle className="pr-12">{title}</DialogTitle>
      {children}
      <DialogClose disabled={pending} aria-label={t('close')} render={
        <Button variant="outline" className="absolute top-3 right-3 w-11 px-0 text-xl" />
      }><span aria-hidden="true">×</span></DialogClose>
    </DialogContent>
  </Dialog>;
}
