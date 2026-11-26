import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { type ReleaseRegistryImageProof } from '@itervane/contracts';
import { temporaryPostgres } from '../../../verification/src/postgres-fixture.js';
import { exportBackup, restoreBackup } from '../../src/persistence/backup.js';
import { fixtureBackupClient } from '../helpers/backup-client.js';
import type { databaseFixture } from '../helpers/database.js';
import type { NativePublishedRunbook } from './restart-proof.js';

const execute = promisify(execFile);
type Restart = { executionId: string; proofSha256: string };
type Published = {
  operationId: string;
  image: Pick<ReleaseRegistryImageProof, 'archive' | 'manifestDigest'>;
  recovered: Restart;
  unknown: Restart;
  runbook: Pick<NativePublishedRunbook, 'versionId' | 'versionSha256'> & { diagnosisRunId: string; snapshotSha256: string };
};

async function checkPublished(database: pg.Pool, basis: Published) {
  const { rows: [release] } = await database.query(`
    SELECT operation.state, candidate.fingerprint, result.sha256 AS verification_sha256,
      candidate.document#>'{image,archive}' AS archive, candidate.document#>>'{image,manifestDigest}' AS manifest_digest
    FROM itervane.release_operations operation
    JOIN itervane.release_candidates candidate ON candidate.id = operation.candidate_id
    JOIN itervane.formal_verification_results result ON result.run_id = candidate.run_id
    WHERE operation.id = $1
  `, [basis.operationId]);
  equal(release.state, 'verified_formal');
  deepStrictEqual(release.archive, basis.image.archive);
  equal(release.manifest_digest, basis.image.manifestDigest);
  const { rows: restarts } = await database.query(`
    SELECT execution.state, receipt.state AS recovery, receipt.proof_sha256 AS proof, receipt.failure
    FROM itervane.operations_executions execution
    JOIN LATERAL (
      SELECT state, proof_sha256, failure FROM itervane.operations_restart_recoveries
      WHERE execution_id = execution.id ORDER BY attempt DESC LIMIT 1
    ) receipt ON true
    WHERE execution.id IN ($1, $2)
    ORDER BY execution.id = $2
  `, [basis.recovered.executionId, basis.unknown.executionId]);
  deepStrictEqual(restarts, [
    { state: 'recovered', recovery: 'verified', proof: basis.recovered.proofSha256, failure: null },
    { state: 'reserved', recovery: 'manual_review', proof: basis.unknown.proofSha256, failure: 'native_unconfirmed' },
  ]);
  const { rows: rules } = await database.query(`
    SELECT snapshot.sha256 AS snapshot_sha256, activation.version_id, activation.version_sha256
    FROM itervane.operations_requests request
    JOIN itervane.task_rule_snapshots snapshot ON snapshot.task_id = request.task_id AND snapshot.purpose = 'operations'
    CROSS JOIN LATERAL jsonb_array_elements(snapshot.document->'entries') AS reference(entry)
    JOIN itervane.rule_package_activations activation
      ON activation.version_id::text = entry->>'versionId' AND activation.package_id::text = entry->>'packageId'
      AND activation.sequence::text = entry->>'sequence'
    WHERE request.run_id = $1 AND entry->>'kind' = 'runbook' AND activation.action = 'publish'
  `, [basis.runbook.diagnosisRunId]);
  deepStrictEqual(rules, [{ snapshot_sha256: basis.runbook.snapshotSha256, version_id: basis.runbook.versionId,
    version_sha256: basis.runbook.versionSha256 }]);
  return { release, restarts, rules };
}

export async function proveNativeBackup(options: {
  database: Awaited<ReturnType<typeof databaseFixture>>;
  source: Awaited<ReturnType<typeof temporaryPostgres>>;
  runnerArchives: string;
  configuration: string[];
  stopControlPlane: () => Promise<void>;
  anonymousStatus: () => Promise<number>;
  publication: Published;
}) {
  const { database, source, publication } = options;
  const expected = await checkPublished(database.admin, publication);
  const sourceName = new URL(database.adminUrl).pathname.slice(1);
  const clients = fixtureBackupClient(source, sourceName, 'itervane_test');
  await options.stopControlPlane();
  await database.disconnect();
  const inventory = await clients.inventory();
  ok(inventory.archives.some(archive => archive.sha256 === publication.image.archive.sha256));
  const root = await mkdtemp(join(tmpdir(), 'itervane-native-backup-'));
  try {
    const retained = join(root, 'retained');
    const selectedConfig = join(root, 'config');
    await mkdir(retained, { mode: 0o700 });
    await mkdir(selectedConfig, { mode: 0o700 });
    // Only known content-addressed names cross from the dedicated Runner account.
    const uid = process.getuid?.();
    ok(uid);
    for (const item of inventory.archives) {
      const name = item.sha256 + '.oci.tar';
      await execute('/usr/bin/sudo', ['-n', 'install', '-m', '0400', '-o', String(uid),
        join(options.runnerArchives, name), join(retained, name)], { timeout: 30_000 });
    }
    for (const sourceFile of options.configuration) await copyFile(sourceFile, join(selectedConfig, basename(sourceFile)));

    const bundle = join(root, 'bundle');
    const recovered = join(root, 'recovered');
    await exportBackup(clients, bundle, retained, selectedConfig);
    const anonymousDuringBackup = await options.anonymousStatus();
    ok(anonymousDuringBackup === 401 || anonymousDuringBackup === 403);
    const target = await temporaryPostgres({ isolated: true });
    try {
      const restore = await restoreBackup(fixtureBackupClient(target, 'itervane_test', 'itervane_test'), bundle, recovered);
      const restored = new pg.Pool({ connectionString: target.url, max: 1 });
      try { deepStrictEqual(await checkPublished(restored, publication), expected); }
      finally { await restored.end(); }
      for (const sourceFile of options.configuration) {
        deepStrictEqual(await readFile(join(recovered, 'configuration', basename(sourceFile))), await readFile(sourceFile));
      }
      const archive = publication.image.archive;
      const restoredArchive = join(recovered, 'artifacts', archive.sha256 + '.oci.tar');
      const proof = await execute('/usr/bin/python3', ['-I', '-B', 'fixtures/runner/verify-stored-oci.py', restoredArchive,
        publication.image.manifestDigest], { timeout: 30_000 });
      equal(proof.stdout.trim(), publication.image.manifestDigest);
      const anonymousAfterRestore = await options.anonymousStatus();
      ok(anonymousAfterRestore === 401 || anonymousAfterRestore === 403);
      return { ...restore, sourcePostgres: source.version, targetPostgres: target.version, archive,
        manifestDigest: publication.image.manifestDigest, releaseOperationId: publication.operationId,
        recoveryEvidenceSha256: publication.recovered.proofSha256, unconfirmedEvidenceSha256: publication.unknown.proofSha256,
        ruleVersionSha256: publication.runbook.versionSha256, ruleSnapshotSha256: publication.runbook.snapshotSha256,
        anonymousDuringBackup, anonymousAfterRestore, nativeUnconfirmedRetained: true,
      };
    } finally { await target.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
