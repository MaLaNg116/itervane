import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rulePackageActivationInputSchema, rulePackageActivationResultSchema, rulePackageImportResultSchema,
  rulePackageReviewInputSchema, type rulePackageActivationViewSchema, type rulePackageDetailSchema } from '@itervane/contracts';
import type { z } from 'zod';
import { ApiFailure } from '../api.js';
import { Failure, Panel } from '../components.js';
import { usePortal, useText } from '../context.js';
import { FormField } from '../forms.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { Textarea } from '../ui/fields.js';

type Version = z.infer<typeof rulePackageDetailSchema>;
type Activation = z.infer<typeof rulePackageActivationViewSchema>;
type ActivationInput = z.infer<typeof rulePackageActivationInputSchema>;
const actions = { publish: 'packagePublish', rollback: 'packageRollback', withdraw: 'packageWithdraw' } as const;

export function RulePackageReview({ version }: { version: Version }) {
  const { api, locale, epoch } = usePortal();
  const cache = useQueryClient();
  const t = useText();
  const path = `/v1/rule-packages/${version.packageId}/versions/${version.versionId}`;
  const [invalid, setInvalid] = useState(false);
  const review = useMutation({ retry: false, gcTime: 0, mutationFn: (body: z.infer<typeof rulePackageReviewInputSchema>) =>
    api.request(`${path}/review`, rulePackageImportResultSchema, locale, { method: 'POST', body }),
  onSettled: () => { void cache.invalidateQueries({ queryKey: [epoch, path] }); } });
  const thirdCheck = version.kind === 'design_skill' ? 'designResources' : 'validationEvidence';
  return <Panel title={t('packageApproval')} className="section-gap">
    {version.review ? <><p role="status">{version.reviewMessage}</p>{version.review.note && <p dir="auto">{version.review.note}</p>}</>
      : <form className="form-stack" aria-busy={review.isPending} onSubmit={event => {
        event.preventDefault();
        if (review.isPending) return;
        const form = new FormData(event.currentTarget);
        const input = rulePackageReviewInputSchema.safeParse({ versionSha256: version.sha256,
          checks: { sourceAndLicense: form.has('sourceAndLicense'), scopeAndGuidance: form.has('scopeAndGuidance'), [thirdCheck]: form.has(thirdCheck) },
          note: form.get('note') || undefined });
        setInvalid(!input.success);
        if (input.success) review.mutate(input.data);
      }}>
        <fieldset className="form-stack" disabled={review.isPending}>
          <label className="flex items-baseline gap-2"><input type="checkbox" name="sourceAndLicense" />{t('packageReviewSource')}</label>
          <label className="flex items-baseline gap-2"><input type="checkbox" name="scopeAndGuidance" />{t('packageReviewScope')}</label>
          <label className="flex items-baseline gap-2"><input type="checkbox" name={thirdCheck} />{t(version.kind === 'design_skill' ? 'packageReviewResources' : 'packageReviewEvidence')}</label>
          <FormField label={t('packageReviewNote')} hint={t('packageReviewHint')}>{props =>
            <Textarea {...props} name="note" maxLength={800} rows={3} />}
          </FormField>
        </fieldset>
        {invalid && <p className="form-error" role="alert">{t('packageReviewHint')}</p>}
        {review.error && <Failure error={review.error} locale={locale} />}
        <div className="actions"><Button type="submit" disabled={review.isPending}>{t('savePackageReview')}</Button></div>
      </form>}
  </Panel>;
}

export function RulePackageActivation({ version, activation }: { version: Version; activation: Activation }) {
  const { api, locale, epoch } = usePortal();
  const cache = useQueryClient();
  const t = useText();
  const path = `/v1/rule-packages/${version.packageId}/activation`;
  const [pending, setPending] = useState<ActivationInput | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const commit = useMutation({ retry: false, gcTime: 0, mutationFn: (body: ActivationInput) =>
    api.request(path, rulePackageActivationResultSchema, locale, { method: 'POST', body }),
  onSuccess: () => setPending(null),
  onError: error => { if (error instanceof ApiFailure && error.code) setPending(null); },
  onSettled: () => { inFlight.current = false; void cache.invalidateQueries({ queryKey: [epoch, path] }); } });
  const action = activation.current?.versionId === version.versionId ? 'withdraw'
    : version.review?.outcome === 'accepted' ? activation.current && activation.history.some(entry => entry.versionId === version.versionId && entry.action !== 'withdraw')
      ? 'rollback' : 'publish' : null;

  return <>
    {!pending && commit.error && <Failure error={commit.error} locale={locale} />}
    {action && <div className="actions section-gap"><Button variant={action === 'withdraw' ? 'destructive' : 'outline'} onClick={() => {
      commit.reset();
      setPending(rulePackageActivationInputSchema.parse({ action, versionId: version.versionId, versionSha256: version.sha256,
        expectedSequence: activation.sequence, idempotencyKey: crypto.randomUUID(),
        ...(action !== 'withdraw' ? { reviewSha256: version.review?.sha256 } : {}) }));
    }}>{t(actions[action])}</Button></div>}
    <Dialog open={pending !== null} disablePointerDismissal onOpenChange={(open, event) => {
      if (open) return;
      if (inFlight.current) event.cancel();
      else setPending(null);
    }}>
      {pending && <DialogContent initialFocus={cancel} aria-busy={commit.isPending}>
        <DialogTitle>{t('packageConfirmActivation')}</DialogTitle>
        <DialogDescription>{t('packageActivationHint')}</DialogDescription>
        <p>{version.text.title} · {version.version} · {t('packageActivationSequence')} {pending.expectedSequence}</p>
        {commit.error && <Failure error={commit.error} locale={locale} />}
        <DialogFooter>
          <DialogClose disabled={commit.isPending} render={<Button ref={cancel} variant="outline" />}>{t('cancel')}</DialogClose>
          <Button disabled={commit.isPending} variant={pending.action === 'withdraw' ? 'destructive' : 'default'} onClick={() => {
            if (inFlight.current) return;
            inFlight.current = true;
            commit.mutate(pending);
          }}>{t(commit.error ? 'retrySubmission' : actions[pending.action])}</Button>
        </DialogFooter>
      </DialogContent>}
    </Dialog>
  </>;
}
