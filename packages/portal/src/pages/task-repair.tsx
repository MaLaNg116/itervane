import { useMutation } from '@tanstack/react-query';
import { formalRepairDtoSchema, formalRepairPatchDtoSchema } from '@itervane/contracts';
import { Failure, Loading, Panel } from '../components.js';
import { usePortal, useRemote, useText } from '../context.js';
import { Button } from '../ui/button.js';
import { Table } from '../ui/table.js';

export function TaskRepair({ taskId, canWrite, disabled, onResume }: {
  taskId: string; canWrite: boolean; disabled: boolean; onResume: () => void;
}) {
  const { api, locale } = usePortal();
  const t = useText();
  const path = `/v1/tasks/${taskId}/repair`;
  const repair = useRemote(path, formalRepairDtoSchema, { poll: true, localized: true });
  const exportPatch = useMutation({ retry: false, mutationFn: async (expectedSha256: string) => {
    const { patch, patchSha256 } = await api.request(`${path}/patch?expectedSha256=${expectedSha256}`, formalRepairPatchDtoSchema, locale);
    const url = URL.createObjectURL(new Blob([JSON.stringify(patch)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `itervane-patch-${patchSha256.slice(0, 12)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } });
  const recorded = repair.data?.status === 'recorded' ? repair.data : undefined;
  const result = recorded?.result;
  const candidate = result?.status === 'candidate_ready' ? result.candidate : null;
  const format = new Intl.NumberFormat(locale);
  return <Panel title={t('formalRepair')} className="section-gap" data-testid="formal-repair">
    {repair.isPending ? <Loading locale={locale} /> : repair.error
      ? <Failure error={repair.error} locale={locale} retry={() => { void repair.refetch(); }} /> : <>
        <p role="status" className={repair.data.status === 'unavailable' || result?.status === 'requires_human' ? 'font-medium' : 'muted'}>
          {repair.data.message}
        </p>
        {canWrite && repair.data.resumeAvailable && <Button variant="outline" disabled={disabled} onClick={onResume}>{t('continueRepair')}</Button>}
        {candidate && recorded && <div className="space-y-4">
          <p lang={result?.locale}>{candidate.summary}</p>
          <Table label={t('repairChanges')} className="min-w-0">
            <thead className="text-left">
              <tr><th scope="col" className="py-2 pr-3">{t('repairFile')}</th><th scope="col" className="px-3 py-2">{t('repairBefore')}</th>
                <th scope="col" className="px-3 py-2">{t('repairAfter')}</th><th scope="col" className="py-2 pl-3">{t('repairEdits')}</th></tr>
            </thead>
            <tbody>{candidate.changes.map(change => <tr key={change.path} className="border-t">
              <td className="py-2 pr-3"><code className="break-text">{change.path}</code></td>
              <td className="px-3 py-2 tabular-nums">{format.format(change.beforeBytes)}</td>
              <td className="px-3 py-2 tabular-nums">{format.format(change.afterBytes)}</td>
              <td className="py-2 pl-3 tabular-nums">{format.format(change.edits)}</td>
            </tr>)}</tbody>
          </Table>
          <details>
            <summary>{t('repairEvidence')}</summary>
            <dl className="detail-grid">
              <div><dt>{t('repairManifest')}</dt><dd><code className="break-text">{candidate.manifestSha256}</code></dd></div>
              <div><dt>{t('repairPatch')}</dt><dd><code className="break-text">{candidate.patchSha256}</code></dd></div>
            </dl>
          </details>
          {canWrite && <Button variant="outline" disabled={exportPatch.isPending} onClick={() => exportPatch.mutate(recorded.sha256)}>
            {t('exportRepairPatch')}
          </Button>}
          {exportPatch.error && <Failure error={exportPatch.error} locale={locale} />}
        </div>}
      </>}
  </Panel>;
}
