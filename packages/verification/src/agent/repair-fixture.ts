import { randomUUID } from 'node:crypto';
import { sha256, type createFormalRepair } from '@itervane/agent';
import { formalAuditResultSchema, formalRepairInputSchema, type Locale, type RepairObservation, type RepairPatch } from '@itervane/contracts';
import { auditFixture } from './formal-fixture.js';
import { npmFixtureApproval, npmFixtureFiles, npmFixturePaths } from './npm-repair-fixture.js';

type Options = Parameters<typeof createFormalRepair>[0];
type Target = RepairObservation['targets'][number];
type SampleFile = Pick<Target, 'path' | 'range' | 'templates' | 'npm'> & { original: string; edits: RepairPatch['files'][number]['edits'] };
export const updatedFixtureManifest = '{"name":"fixture","version":"1.1.0"}\n';
export const fixtureAuditNarrative = 'fixture value omitted from the model';

function fixtureAuthority(locale: Locale, npm = false) {
  const { input: fromAudit, inspection, checkpointer, providerSha256, authorize } = auditFixture(locale, npm ? 0 : 1, npm);
  const { taskId, runId, projectId, generation, source, dataClass, catalog } = fromAudit.document;
  const scanner: Target['scanner'] = npm ? 'trivy' : 'gitleaks';
  const originalFinding = inspection.snapshot.reports[npm ? 1 : 0].findings[0]!;
  const { advisoryId, name, installedVersion, fixedVersion } = npmFixtureApproval;
  const finding = npm ? { ...originalFinding, path: npmFixturePaths.lock, ruleId: advisoryId,
    npm: { name, installedVersion, fixedVersions: [fixedVersion] },
  } : originalFinding;
  const snapshotSha256 = inspection.snapshot.manifestSha256;
  const audit = formalAuditResultSchema.parse({
    version: 1, taskId, runId, projectId, generation, locale, inputSha256: fromAudit.sha256,
    checkpointId: randomUUID(), inspectionSha256: fromAudit.document.inspection.receiptSha256, snapshotSha256, catalogSha256: catalog.sha256,
    status: 'completed', reason: 'audit_complete', provider: 'anthropic', usage: { turns: 3, toolCalls: 2, tokens: 60 }, evidence: [], trace: [],
    checklist: { summary: fixtureAuditNarrative, coverage: 'complete', limits: ['Fixed policy'], evidenceIds: [sha256('scans')], hypotheses: [],
      findings: [{ ...finding, scanner, certainty: npm ? 'confirmed' : 'suspected', impact: fixtureAuditNarrative, suggestion: fixtureAuditNarrative }],
    },
  });
  const document = formalRepairInputSchema.parse({
    version: 1, taskId, runId, projectId, generation, source, dataClass, locale, inspection: fromAudit.document.inspection,
    audit: { inputSha256: fromAudit.sha256, checkpointId: audit.checkpointId, resultSha256: sha256(JSON.stringify(audit)) },
    catalogSha256: catalog.sha256, findingIds: [finding.id],
  });
  const input = { document, sha256: sha256(JSON.stringify(document)) };
  const { planSha256: _plan, ...inspectionScope } = inspection.scope;
  const reply = () => {
    const domainId = randomUUID();
    const operationId = randomUUID();
    const commandSha256 = sha256(operationId);
    const scope = { ...inspectionScope, version: 1 as const, requestId: randomUUID(), operationId,
      repairInputSha256: input.sha256, baseSnapshotSha256: snapshotSha256, commandSha256, commandBytes: 100,
    };
    return { scope, domainId, imageSha256: inspection.imageSha256, originSha256: inspection.originSha256, commitSha256: inspection.commitSha256,
      cleanupConfirmed: true as const, sessionVerified: true as const,
      snapshot: { runId: domainId, ...source, tree: inspection.snapshot.tree, manifestSha256: snapshotSha256,
        files: inspection.snapshot.files, commandSha256, readOnly: true as const, offline: true as const },
    };
  };
  return { input, audit, checkpointer, providerSha256, authorize, finding, scanner, reply };
}

function fixtureTools({ input, finding, scanner, reply }: ReturnType<typeof fixtureAuthority>, files: SampleFile[]) {
  const baseSnapshotSha256 = input.document.inspection.snapshotSha256;
  const expectedPatch: RepairPatch = { version: 1, baseSnapshotSha256, files: files.map(({ path, original, edits }) =>
    ({ path, beforeSha256: sha256(original), edits })),
  };
  const readTargets: Options['readTargets'] = async (ids, signal) => {
    signal.throwIfAborted();
    if (ids.length !== 1 || ids[0] !== finding.id) throw new Error('repair_fixture_scope');
    const base = reply();
    return { ...base, kind: 'repair_observation', scope: { ...base.scope, operation: 'observe_repair' },
      snapshot: { ...base.snapshot, observation: { version: 1, operationId: base.scope.operationId, repairInputSha256: input.sha256,
        baseSnapshotSha256, targets: files.map(({ original, edits: _edits, ...target }) => ({ ...target, scanner, findingId: finding.id,
          line: finding.line, status: 'text', file: { sha256: sha256(original), bytes: Buffer.byteLength(original) },
        })),
      } },
    };
  };
  const apply: Options['apply'] = async ({ findingIds, patch }, signal) => {
    signal.throwIfAborted();
    if (findingIds.length !== 1 || findingIds[0] !== finding.id || JSON.stringify(patch) !== JSON.stringify(expectedPatch)) {
      throw new Error('repair_fixture_change');
    }
    const changes = patch.files.map(({ path, beforeSha256, edits }, index) => {
      const original = Buffer.from(files[index]!.original);
      let changed = original;
      for (const { startByte, endByte, replacement } of edits.toReversed()) {
        changed = Buffer.concat([changed.subarray(0, startByte), Buffer.from(replacement), changed.subarray(endByte)]);
      }
      return { path, beforeSha256, afterSha256: sha256(changed.toString('utf8')), beforeBytes: original.length, afterBytes: changed.length, edits: edits.length };
    });
    const base = reply();
    return { ...base, kind: 'repair_receipt', scope: { ...base.scope, operation: 'apply_repair' },
      snapshot: { ...base.snapshot, candidate: { version: 1, operationId: base.scope.operationId, repairInputSha256: input.sha256,
        workspaceSha256: sha256('repair workspace'), baseSnapshotSha256, patchSha256: sha256(JSON.stringify(patch)),
        candidateManifestSha256: sha256(JSON.stringify(changes)), changes,
      } },
    };
  };
  return { readTargets, apply };
}

export function syntheticRepairFixture(locale: Locale, template: boolean) {
  const authority = fixtureAuthority(locale);
  const firstLine = 'DEMO_ONLY=synthetic-placeholder\n';
  const original = template ? firstLine + 'KEEP=on\n' : '{"name":"fixture","version":"1.0.0"}\n';
  const expectedText = template ? 'KEEP=on\n' : updatedFixtureManifest;
  const targetLine = template ? firstLine : original;
  const range = { startByte: 0, endByte: Buffer.byteLength(targetLine), sha256: sha256(targetLine) };
  const file: SampleFile = { path: authority.finding.path, original, range, templates: template ? ['remove-env-entry-v1'] : [],
    edits: [{ startByte: 0, endByte: range.endByte, replacement: template ? '' : expectedText }],
  };
  return { ...authority, ...fixtureTools(authority, [file]), original: Buffer.from(original), expectedText };
}

export function syntheticNpmRepairFixture(locale: Locale, approved = true) {
  const authority = fixtureAuthority(locale, true);
  const { name, installedVersion, fixedVersion } = npmFixtureApproval;
  const files = npmFixtureFiles();
  const samples: SampleFile[] = files.map(({ path, original, edits }) => ({ path, original, edits, range: null, templates: [],
    ...(approved ? { npm: { name, installedVersion, fixedVersion, edits } } : {}),
  }));
  return { ...authority, ...fixtureTools(authority, samples), files };
}
