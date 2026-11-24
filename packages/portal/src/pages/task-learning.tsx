import { useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { admissionDtoSchema, candidateValidationViewSchema, prepareCandidatePackageSchema, ruleExtractionViewSchema,
  rulePackageImportResultSchema, type startCandidateValidationSchema, type TaskDto } from '@itervane/contracts';
import type { z } from 'zod';
import { ApiFailure } from '../api.js';
import { Failure, Loading, Panel } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { FormField } from '../forms.js';
import { Disclosure } from '../motion.js';
import { navigate } from '../router.js';
import { Button } from '../ui/button.js';
import { NativeSelect } from '../ui/fields.js';
import { Table } from '../ui/table.js';
import { readPackageMetadata, RulePackageFields } from './rule-package-fields.js';

const sampleLabel = { violation: 'candidateViolation', corrected: 'candidateCorrected', lookalike: 'candidateLookalike' } as const;
type ValidationRequest = z.infer<typeof startCandidateValidationSchema>;
type ValidationResult = NonNullable<z.infer<typeof candidateValidationViewSchema>['result']>;

export function TaskRuleExtraction({ task, canWrite }: { task: TaskDto; canWrite: boolean }) {
  const { api, locale } = usePortal();
  const t = useText();
  const state = useRemote(`/v1/tasks/${task.id}/rule-extraction`, ruleExtractionViewSchema, { poll: true, localized: true });
  const attempt = useRef<ValidationRequest | null>(null);
  const validate = useMutation({ retry: false, gcTime: 0, mutationFn: ({ id, sha256 }: { id: string; sha256: string }) => {
    if (attempt.current?.extractionResultSha256 !== sha256) attempt.current = { extractionResultSha256: sha256,
      idempotencyKey: crypto.randomUUID(), locale };
    return api.request(`/v1/projects/${task.projectId}/rule-candidates/${id}/validations`, admissionDtoSchema, locale,
      { method: 'POST', body: attempt.current });
  }, onSuccess: result => navigate(`#/tasks/${result.task.id}`) });
  const receipt = state.data?.result;
  const outcome = receipt?.document.extraction.result;
  return <Panel title={t('ruleExtraction')}>
    {state.isPending ? <Loading locale={locale} /> : state.error ? <Failure error={state.error} locale={locale} retry={() => { void state.refetch(); }} /> : <>
      <p role="status">{state.data.message}</p>
      <p className="muted">{t('learningCaseId')} <code className="break-text">{state.data.source.caseId}</code></p>
      {receipt && outcome?.outcome === 'candidate' && <>
        <Disclosure title={outcome.candidate.text[locale].title}><p>{outcome.candidate.text[locale].appliesTo}</p>
          <p>{outcome.candidate.text[locale].limitation}</p>
          <pre className="whitespace-pre-wrap break-words" dir="auto">{JSON.stringify(outcome.candidate, null, 2)}</pre>
        </Disclosure>
        {canWrite && <div className="actions section-gap">
          {validate.error && <Failure error={validate.error} locale={locale} />}
          <Button disabled={validate.isPending} onClick={() => validate.mutate({ id: receipt.id, sha256: receipt.sha256 })}>
            {t(validate.error ? 'retrySubmission' : 'candidateValidate')}
          </Button>
        </div>}
      </>}
      {outcome?.outcome === 'retain_case' && <p>{t('candidateRetained')}</p>}
      {outcome?.outcome === 'duplicate' && <p>{t('candidateDuplicate')} <code className="break-text">{outcome.existingCandidateId}</code></p>}
    </>}
  </Panel>;
}

export function TaskCandidateValidation({ taskId, canPublish }: { taskId: string; canPublish: boolean }) {
  const { locale } = usePortal();
  const t = useText();
  const validation = useRemote(`/v1/tasks/${taskId}/candidate-validation`, candidateValidationViewSchema,
    { localized: true, poll: true, keepOnLocaleChange: true });
  if (validation.isPending) return <Panel title={t('packageValidation')}><Loading locale={locale} /></Panel>;
  if (validation.error) return <Panel title={t('packageValidation')}><Failure error={validation.error} locale={locale} retry={() => { void validation.refetch(); }} /></Panel>;
  const { state, result, message } = validation.data;
  const evidence = result?.document.evidence;
  return <Panel title={t('packageValidation')}>
    <p role="status">{message}</p>
    {result && <p className="muted">{t('candidateReceipt')} <code className="break-text">{result.sha256}</code></p>}
    {evidence?.kind === 'code_rule' && <Table label={t('candidateReceipt')}>
      <thead><tr><th scope="col">{t('learningCandidate')}</th><th scope="col">{t('candidateMatches')}</th></tr></thead>
      <tbody>{evidence.receipt.proof.result.samples.map(sample => <tr key={sample.name}>
        <td>{t(sampleLabel[sample.name])}</td><td>{sample.status === 'checked' ? sample.matches : t('candidateUnavailable')}</td>
      </tr>)}</tbody>
    </Table>}
    {evidence && <Disclosure title={t('candidateReceipt')}><pre className="whitespace-pre-wrap break-words" dir="auto">{JSON.stringify(evidence, null, 2)}</pre></Disclosure>}
    {state === 'succeeded' && result?.document.status === 'passed' && canPublish && <Disclosure title={t('candidatePackage')}>
      <PrepareCandidateDraft key={result.id} result={result} />
    </Disclosure>}
  </Panel>;
}

function PrepareCandidateDraft({ result }: { result: ValidationResult }) {
  const { api, locale } = usePortal();
  const t = useText();
  const { projectId, candidateId } = result.document;
  const submit = useMutation({ retry: false, gcTime: 0, mutationFn: (form: FormData) => {
    const draft = prepareCandidatePackageSchema.safeParse({ ...readPackageMetadata(form), scope: form.get('scope'),
      validationId: result.id, validationSha256: result.sha256 });
    if (!draft.success) throw new ApiFailure('invalidRulePackage');
    return api.request(`/v1/projects/${projectId}/rule-candidates/${candidateId}/package-drafts`, rulePackageImportResultSchema, locale,
      { method: 'POST', body: draft.data });
  }, onSuccess: ({ version }) => navigate(`#/rule-packages/${version.packageId}/versions/${version.versionId}`) });
  return <form className="form-stack" aria-busy={submit.isPending} onSubmit={event => {
    event.preventDefault();
    if (!submit.isPending) submit.mutate(new FormData(event.currentTarget));
  }}>
    <fieldset className="form-stack" disabled={submit.isPending}>
      <RulePackageFields />
      <FormField label={t('packageScope')}>{props => <NativeSelect {...props} name="scope" defaultValue="project">
        <option value="project">{t('packageProject')}</option><option value="workspace">{t('packageWorkspace')}</option>
      </NativeSelect>}</FormField>
    </fieldset>
    {submit.error && <Failure error={submit.error} locale={locale} />}
    <div className="actions"><Button type="submit" disabled={submit.isPending}>{t('saveRuleDraft')}</Button></div>
  </form>;
}
