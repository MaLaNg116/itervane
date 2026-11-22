import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  admissionDtoSchema, operationsLaunchViewSchema, operationsObservationViewSchema, type StartOperationsTask, type TaskDto,
} from '@itervane/contracts';
import { ApiFailure } from '../api.js';
import { Failure, Loading, Panel, formatTime } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Disclosure } from '../motion.js';
import { navigate } from '../router.js';
import { Button } from '../ui/button.js';

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
    }}>{t(error ? 'retrySubmission' : 'operationsObserve')}</Button>}
    {currentSubmission && launch.isPending && <p className="muted" role="status">{t('operationsStarting')}</p>}
    {error && <Failure error={error} locale={locale} />}
  </div>;
}

export function TaskOperations({ task }: { task: Pick<TaskDto, 'id' | 'runId' | 'version'> }) {
  const { locale } = usePortal(); const t = useText();
  const query = useRemote(`/v1/tasks/${task.id}/operations`, operationsObservationViewSchema, {
    localized: true, revision: task.version, poll: true,
  });
  const view = query.data?.taskId === task.id && query.data.runId === task.runId && query.data.taskVersion === task.version ? query.data : undefined;
  return <Panel title={t('operationsObservation')} data-testid="operations-observation">
    {query.error ? <Failure error={query.error} locale={locale} retry={() => { void query.refetch(); }} />
      : !view ? <Loading locale={locale} /> : <div className="space-y-3">
        <div role="status" aria-atomic="true">
          <p>{view.message}</p>
          {view.reasonMessage && <p className="muted">{view.reasonMessage}</p>}
        </div>
        {view.observation && <>
          <dl className="detail-grid">
            <div><dt>{t('operationsContainerState')}</dt><dd>{view.observation.stateLabel}</dd></div>
            <div><dt>{t('operationsObservedAt')}</dt><dd><time dateTime={view.observation.observedAt}>
              {formatTime(view.observation.observedAt, locale)}</time></dd></div>
          </dl>
          <Disclosure title={t('operationsEvidence')}>
            <dl className="detail-grid">
              <div><dt>{t('releaseOperation')}</dt><dd><code className="break-text">{view.releaseOperationId}</code></dd></div>
              <div><dt>{t('operationsReceipt')}</dt><dd><code className="break-text">{view.observation.receiptSha256}</code></dd></div>
            </dl>
          </Disclosure>
        </>}
      </div>}
  </Panel>;
}
