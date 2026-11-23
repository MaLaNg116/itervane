import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  admissionDtoSchema, operationsLaunchViewSchema, operationsObservationViewSchema, type OperationsObservationView,
  type StartOperationsTask, type TaskDto,
} from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure, Loading, Panel, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { navigate } from '../router.js';
import { Button } from '../ui/button.js';
import { OperationsProposal } from './task-operations-proposal.js';
import { OperationsRepair } from './task-operations-repair.js';

export function StartOperationsObservation({ taskId, projectId, releaseOperationId }: {
  taskId: string; projectId: string; releaseOperationId: string | undefined;
}) {
  const { api, locale } = usePortal(); const t = useText(); const cache = useQueryClient();
  const query = useRemote(`/v1/tasks/${taskId}/operations-option`, operationsLaunchViewSchema, { poll: true, enabled: Boolean(releaseOperationId) });
  const retry = useRef<StartOperationsTask | undefined>(undefined);
  const inFlight = useRef(false);
  const launch = useMutation({
    retry: false, gcTime: 0,
    mutationFn: async (input: StartOperationsTask) => {
      const { task } = await api.request('/v1/operations/diagnoses', admissionDtoSchema, locale, { method: 'POST', body: input });
      if (task.projectId !== projectId || task.workflow !== 'operations') throw new ApiFailure('invalidResponse');
      return task;
    },
    onSettled: () => { inFlight.current = false; void cache.invalidateQueries(); },
  });
  const option = query.error ? null : query.data?.option;
  const target = option?.projectId === projectId && option.releaseOperationId === releaseOperationId ? option : null;
  const currentSubmission = Boolean(releaseOperationId && launch.variables?.expectedReleaseOperationId === releaseOperationId);
  const error = currentSubmission ? launch.error : null;
  if (!target && !error && !(currentSubmission && launch.isPending)) return null;
  return <div className="mt-4 space-y-2">
    {target && <Button variant="outline" disabled={launch.isPending} onClick={() => {
      if (inFlight.current) return;
      const previous = retry.current;
      const input = previous?.environmentId === target.environmentId && previous.expectedReleaseOperationId === target.releaseOperationId ? previous : {
        projectId, environmentId: target.environmentId, expectedReleaseOperationId: target.releaseOperationId, idempotencyKey: crypto.randomUUID(), locale,
      };
      retry.current = input;
      inFlight.current = true;
      launch.mutate(input, { onSuccess: task => {
        if (location.hash === `#/tasks/${taskId}`) navigate(`#/tasks/${task.id}`);
      } });
    }}>{t(error ? 'retrySubmission' : target.diagnosis ? 'operationsDiagnose' : 'operationsObserve')}</Button>}
    {currentSubmission && launch.isPending && <p className="muted" role="status">
      {t(target?.diagnosis ? 'operationsDiagnosisStarting' : 'operationsStarting')}</p>}
    {error && <Failure error={error} locale={locale} />}
  </div>;
}

export function TaskOperations({ task }: { task: Pick<TaskDto, 'id' | 'projectId' | 'runId' | 'version'> }) {
  const { locale } = usePortal(); const t = useText();
  const query = useRemote(`/v1/tasks/${task.id}/operations`, operationsObservationViewSchema, {
    localized: true, revision: task.version, poll: true,
  });
  const view = query.data?.taskId === task.id && query.data.runId === task.runId && query.data.taskVersion === task.version ? query.data : undefined;
  return <Panel title={t(view?.diagnosis && !query.error ? 'operationsDiagnosis' : 'operationsObservation')} data-testid="operations-observation">
    {query.error ? <Failure error={query.error} locale={locale} retry={() => { void query.refetch(); }} />
      : !view ? <Loading locale={locale} /> : <div className="space-y-3">
        <div role="status" aria-atomic="true">
          <p>{view.diagnosis ? view.reasonMessage ?? view.message : view.message}</p>
          {!view.diagnosis && view.reasonMessage && <p className="muted">{view.reasonMessage}</p>}
        </div>
        {view.observation && <>
          <dl className="detail-grid">
            <div><dt>{t('operationsContainerState')}</dt><dd>{view.observation.stateLabel}</dd></div>
            <div><dt>{t('operationsObservedAt')}</dt><dd><time dateTime={view.observation.observedAt}>
              {formatTime(view.observation.observedAt, locale)}</time></dd></div>
          </dl>
          {!view.diagnosis && <Disclosure title={t('operationsEvidence')}>
            <dl className="detail-grid">
              <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{view.releaseOperationId}</code></dd></div>
              <div><dt>{t('operationsReceipt')}</dt><dd><code className="break-text">{view.observation.receiptSha256}</code></dd></div>
            </dl>
          </Disclosure>}
          {view.diagnosis && <>
            <DiagnosisDetails diagnosis={view.diagnosis} observationDigest={view.observation.receiptSha256} />
            <OperationsProposal key={view.runId} task={task} />
            {view.diagnosis.recommendation.code === 'investigate_code' && <OperationsRepair key={`repair-${view.runId}`} task={task} />}
          </>}
        </>}
      </div>}
  </Panel>;
}

type Diagnosis = NonNullable<OperationsObservationView['diagnosis']>;
type Fact = Diagnosis['facts'][number];
const sectionLabels = {
  container: 'operationsEvidenceContainer', release: 'operationsEvidenceRelease',
  logs: 'operationsEvidenceLogs', metrics: 'operationsEvidenceMetrics',
} as const satisfies Record<Fact['section'], string>;

function DiagnosisDetails({ diagnosis, observationDigest }: { diagnosis: Diagnosis; observationDigest: string }) {
  const t = useText();
  const sections = new Map(diagnosis.facts.map(fact => [fact.evidenceId, fact.section]));
  const citations = (evidenceIds: readonly string[]) =>
    <ul aria-label={t('operationsCitedEvidence')} className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm muted">
      {evidenceIds.map(id => {
        const section = sections.get(id);
        return section && <li key={id}>{t(sectionLabels[section])}</li>;
      })}
    </ul>;
  return <div className="space-y-4" data-testid="operations-diagnosis">
    <div>
      <h3 className="text-sm font-medium">{t('operationsRecommendation')}</h3>
      <p>{diagnosis.recommendation.message}</p>
      {citations(diagnosis.recommendation.evidenceIds)}
    </div>
    {diagnosis.hypotheses.length > 0 && <div>
      <h3 className="text-sm font-medium">{t('operationsHypotheses')}</h3>
      <ul className="space-y-2">
        {diagnosis.hypotheses.map(item => <li key={item.code}>{item.message}{citations(item.evidenceIds)}</li>)}
      </ul>
    </div>}
    <Disclosure title={t('operationsDiagnosisEvidence')}>
      <ul className="space-y-3">
        {diagnosis.facts.map(fact => <li key={fact.evidenceId}>
          <h4 className="text-sm font-medium">{t(sectionLabels[fact.section])}</h4>
          <DiagnosisFactDetails fact={fact} />
          <dl className="text-sm">
            <dt className="muted">{t('operationsProofDigest')}</dt><dd><code className="break-text">{fact.proofSha256}</code></dd>
          </dl>
        </li>)}
      </ul>
      <dl className="mt-3 detail-grid">
        <div><dt>{t('operationsDiagnosisReceipt')}</dt><dd><code className="break-text">{diagnosis.receiptSha256}</code></dd></div>
        <div><dt>{t('operationsReceipt')}</dt><dd><code className="break-text">{observationDigest}</code></dd></div>
      </dl>
    </Disclosure>
  </div>;
}

function DiagnosisFactDetails({ fact }: { fact: Fact }) {
  const { locale } = usePortal();
  const t = useText();
  if (fact.section === 'container') return null;
  if (fact.section === 'release') return <dl className="detail-grid">
    <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{fact.result.current.operationId}</code></dd></div>
    {fact.result.previous && <div><dt>{t('operationsPreviousRelease')}</dt>
      <dd><code className="break-text">{fact.result.previous.operationId}</code></dd></div>}
  </dl>;
  const number = new Intl.NumberFormat(locale);
  if (fact.section === 'logs') return <dl className="detail-grid">
    <div><dt>{t('operationsLogLines')}</dt><dd>{number.format(fact.result.lines)}</dd></div>
    <div><dt>{t('operationsWarningLines')}</dt><dd>{number.format(fact.result.warningLines)}</dd></div>
    <div><dt>{t('operationsErrorLines')}</dt><dd>{number.format(fact.result.errorLines)}</dd></div>
  </dl>;
  if (fact.result.status === 'unavailable') return <p className="muted">{t('operationsNoMetricSamples')}</p>;
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return <dl className="detail-grid">
    <div><dt>{t('operationsMetricSamples')}</dt><dd>{number.format(fact.result.dataPoints)}</dd></div>
    <div><dt>{t('operationsAverageCpu')}</dt><dd>{percent.format(fact.result.cpu.average / 100)}</dd></div>
    {fact.result.memory && <div><dt>{t('operationsAverageMemory')}</dt><dd>{percent.format(fact.result.memory.average / 100)}</dd></div>}
  </dl>;
}
