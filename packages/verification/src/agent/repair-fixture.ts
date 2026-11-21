import { randomUUID } from 'node:crypto';
import { sha256, type createFormalRepair } from '@itervane/agent';
import { formalAuditResultSchema, formalRepairInputSchema, type Locale, type RepairPatch } from '@itervane/contracts';
import { auditFixture } from './formal-fixture.js';

type Options = Parameters<typeof createFormalRepair>[0];
export const updatedFixtureManifest = '{"name":"fixture","version":"1.1.0"}\n';
export const fixtureAuditNarrative = 'fixture value omitted from the model';

export function syntheticRepairFixture(locale: Locale, template: boolean) {
  const { input: fromAudit, inspection, checkpointer, providerSha256, authorize } = auditFixture(locale, Number(template), !template);
  const { taskId, runId, projectId, generation, source, dataClass, catalog } = fromAudit.document;
  const scanner = template ? 'gitleaks' : 'trivy';
  const finding = inspection.snapshot.reports[template ? 0 : 1].findings[0]!;
  const snapshotSha256 = inspection.snapshot.manifestSha256;
  const audit = formalAuditResultSchema.parse({
    version: 1, taskId, runId, projectId, generation, locale, inputSha256: fromAudit.sha256,
    checkpointId: randomUUID(), inspectionSha256: fromAudit.document.inspection.receiptSha256, snapshotSha256, catalogSha256: catalog.sha256,
    status: 'completed', reason: 'audit_complete', provider: 'anthropic', usage: { turns: 3, toolCalls: 2, tokens: 60 }, evidence: [], trace: [],
    checklist: { summary: fixtureAuditNarrative, coverage: 'complete', limits: ['Fixed policy'], evidenceIds: [sha256('scans')], hypotheses: [],
      findings: [{ ...finding, scanner, certainty: template ? 'suspected' : 'confirmed', impact: fixtureAuditNarrative, suggestion: fixtureAuditNarrative }],
    },
  });
  const document = formalRepairInputSchema.parse({
    version: 1, taskId, runId, projectId, generation, source, dataClass, locale, inspection: fromAudit.document.inspection,
    audit: { inputSha256: fromAudit.sha256, checkpointId: audit.checkpointId, resultSha256: sha256(JSON.stringify(audit)) },
    catalogSha256: catalog.sha256, findingIds: [finding.id],
  });
  const input = { document, sha256: sha256(JSON.stringify(document)) };
  const firstLine = 'DEMO_ONLY=synthetic-placeholder\n';
  const original = Buffer.from(template ? firstLine + 'KEEP=on\n' : '{"name":"fixture","version":"1.0.0"}\n');
  const expectedText = template ? 'KEEP=on\n' : updatedFixtureManifest;
  const file = { sha256: sha256(original.toString('utf8')), bytes: original.length };
  const range = template ? { startByte: 0, endByte: Buffer.byteLength(firstLine), sha256: sha256(firstLine) } : null;
  const expectedPatch: RepairPatch = { version: 1, baseSnapshotSha256: snapshotSha256, files: [{ path: finding.path, beforeSha256: file.sha256,
    edits: [{ startByte: 0, endByte: range?.endByte ?? file.bytes, replacement: template ? '' : expectedText }],
  }] };
  const { planSha256: _plan, ...inspectionScope } = inspection.scope;
  const reply = () => {
    const domainId = randomUUID();
    const operationId = randomUUID();
    const commandSha256 = sha256(operationId);
    const scope = { ...inspectionScope, version: 1 as const, requestId: randomUUID(), operationId,
      repairInputSha256: input.sha256, baseSnapshotSha256: snapshotSha256, commandSha256, commandBytes: 100,
    };
    const { repositoryId, commit } = source;
    return { scope, domainId, imageSha256: inspection.imageSha256, originSha256: inspection.originSha256, commitSha256: inspection.commitSha256,
      cleanupConfirmed: true as const, sessionVerified: true as const,
      snapshot: { runId: domainId, repositoryId, commit, tree: inspection.snapshot.tree, manifestSha256: snapshotSha256,
        files: inspection.snapshot.files, commandSha256, readOnly: true as const, offline: true as const },
    };
  };
  const readTargets: Options['readTargets'] = async (ids, signal) => {
    signal.throwIfAborted();
    if (ids.length !== 1 || ids[0] !== finding.id) throw new Error('repair_fixture_scope');
    const base = reply();
    return { ...base, kind: 'repair_observation', scope: { ...base.scope, operation: 'observe_repair' },
      snapshot: { ...base.snapshot, observation: { version: 1, operationId: base.scope.operationId, repairInputSha256: input.sha256,
        baseSnapshotSha256: snapshotSha256, targets: [{ findingId: finding.id, path: finding.path, line: finding.line, scanner,
          status: 'text', file, range, templates: template ? ['remove-env-entry-v1'] : [],
        }],
      } },
    };
  };
  const apply: Options['apply'] = async ({ findingIds, patch }, signal) => {
    signal.throwIfAborted();
    if (findingIds.length !== 1 || findingIds[0] !== finding.id || JSON.stringify(patch) !== JSON.stringify(expectedPatch)) {
      throw new Error('repair_fixture_change');
    }
    const edit = patch.files[0]!.edits[0]!;
    const changed = Buffer.concat([original.subarray(0, edit.startByte), Buffer.from(edit.replacement), original.subarray(edit.endByte)]);
    const base = reply();
    return { ...base, kind: 'repair_receipt', scope: { ...base.scope, operation: 'apply_repair' },
      snapshot: { ...base.snapshot, candidate: { version: 1, operationId: base.scope.operationId, repairInputSha256: input.sha256,
        workspaceSha256: sha256('repair workspace'), baseSnapshotSha256: snapshotSha256, patchSha256: sha256(JSON.stringify(patch)),
        candidateManifestSha256: sha256('candidate manifest'), changes: [{ path: finding.path, beforeSha256: file.sha256,
          afterSha256: sha256(changed.toString('utf8')), beforeBytes: original.length, afterBytes: changed.length, edits: 1,
        }],
      } },
    };
  };
  return { input, audit, checkpointer, providerSha256, authorize, readTargets, apply, finding, original, expectedText };
}
