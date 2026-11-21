import { deepStrictEqual, equal, fail, ok, rejects } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formalReleaseManifestSchema, formalReleaseTargetSchema, idSchema, qualifiedOciArchiveVerificationSchema } from '@itervane/contracts';
import { QualifiedInspectionClient, sha256, type QualifiedControllerAddress } from '@itervane/runner';
import { openDatabase } from '../../src/persistence/database.js';
import { ReleaseRegistryPublisher } from '../../src/runtime/release-registry.js';

export async function readApprovedArchive(databaseUrl: string, address: QualifiedControllerAddress, rawOperationId: unknown,
  registry: { origin: string; materializer: string }) {
  ok(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(registry.origin));
  const operationId = idSchema.parse(rawOperationId);
  const database = await openDatabase(databaseUrl);
  try {
    // This read-only trial binds the native transport to its real frozen candidate.
    // The formal release consumer will additionally reserve and validate its own execution fence.
    async function approval() {
      const { rows: [row] } = await database.pool.query<{
        candidate: unknown; fingerprint: string; archive: unknown; result_sha: string; target: unknown;
      }>(`
        SELECT c.document AS candidate, c.fingerprint, v.document->'archiveVerification' AS archive, v.sha256 AS result_sha,
          target.document AS target
        FROM itervane.release_operations o
        JOIN itervane.release_candidates c ON c.id=o.candidate_id AND c.environment_id=o.environment_id
        JOIN itervane.tasks t ON t.id=c.task_id AND t.project_id=c.project_id AND t.requested_by=c.requested_by
        JOIN itervane.task_runs r ON r.id=c.run_id AND r.task_id=t.id AND r.generation=t.generation
        JOIN itervane.run_runtime runtime ON runtime.run_id=r.id AND runtime.reason='release_queued'
        JOIN itervane.release_decisions d ON d.candidate_id=c.id AND d.version=o.approval_version AND d.action='confirm'
        JOIN itervane.projects project ON project.id=t.project_id
        JOIN itervane.workspace_members owner ON owner.workspace_id=project.workspace_id AND owner.principal_id=d.actor_id AND owner.grant_id=d.grant_id
        JOIN itervane.formal_release_targets target ON target.environment_id=o.environment_id AND target.project_id=c.project_id
        JOIN itervane.formal_verification_results v ON v.run_id=r.id
        WHERE o.id=$1 AND o.state='queued' AND t.state='queued'
          AND target.revision::text=c.document#>>'{target,revision}' AND target.sha256=c.document#>>'{target,mappingSha256}'
          AND (c.document->>'validUntil')::timestamptz > clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM itervane.release_decisions later WHERE later.candidate_id=c.id AND later.version>d.version)
      `, [operationId]);
      ok(row);
      const candidate = formalReleaseManifestSchema.parse(row.candidate);
      const proof = qualifiedOciArchiveVerificationSchema.parse(row.archive);
      equal(candidate.verification.resultSha256, row.result_sha);
      equal(sha256(JSON.stringify(candidate)), row.fingerprint);
      equal(candidate.image.runnerImageSha256, proof.runnerImageSha256);
      deepStrictEqual(candidate.image.archive, proof.archive);
      const mapping = formalReleaseTargetSchema.parse(row.target);
      equal(sha256(JSON.stringify(mapping)), candidate.target.mappingSha256);
      equal(mapping.registryOrigin, registry.origin);
      const { archive, manifestDigest, configDigest } = candidate.image;
      return { fingerprint: row.fingerprint, proof, image: { archive, manifestDigest, configDigest },
        target: { imageRepository: mapping.imageRepository, registryOrigin: registry.origin } };
    }

    const approved = await approval();
    const { fingerprint, proof, image, target } = approved;
    const runner = new QualifiedInspectionClient(address);
    const originalTmp = process.env.TMPDIR;
    const staging = await mkdtemp(join(tmpdir(), 'itervane-archive-fixture-'));
    let checks = 0;
    const authorize = async () => {
      checks++;
      deepStrictEqual(await approval(), approved);
    };
    const unreachable = async () => fail('unverified archive reached its consumer');
    process.env.TMPDIR = staging;
    try {
      const received = await runner.withRetainedArchive(proof, authorize, async path => {
        const [file, directory] = await Promise.all([lstat(path), lstat(dirname(path))]);
        equal(file.mode & 0o777, 0o400);
        equal(directory.mode & 0o777, 0o700);
        equal(file.uid, process.getuid?.());
        equal(directory.uid, process.getuid?.());
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
        return { bytes, archiveSha256: hash.digest('hex') };
      });
      deepStrictEqual(received, { bytes: proof.archive.bytes, archiveSha256: proof.archive.sha256 });
      ok(checks >= 2);
      deepStrictEqual(await readdir(staging), []);

      const wrongImage = sha256('different runner version');
      const wrongRunner = new QualifiedInspectionClient({ ...address, imageSha256: wrongImage });
      await rejects(wrongRunner.withRetainedArchive({ ...proof, runnerImageSha256: wrongImage }, unreachable, unreachable), /runner_archive_handshake/);
      const wrongSize = { ...proof, archive: { ...proof.archive, bytes: proof.archive.bytes - 1 } };
      await rejects(runner.withRetainedArchive(wrongSize, unreachable, unreachable), /runner_archive_handshake/);
      let authorizedOnce = false;
      await rejects(runner.withRetainedArchive(proof, async () => {
        if (authorizedOnce) throw new Error('fixture_revoked');
        await authorize();
        authorizedOnce = true;
      }, unreachable), /fixture_revoked/);
      deepStrictEqual(await readdir(staging), []);
      const publisher = new ReleaseRegistryPublisher({ origin: registry.origin }, { materializer: registry.materializer, skopeo: '/usr/bin/skopeo' });
      const observer = new ReleaseRegistryPublisher({ origin: registry.origin },
        { materializer: '/itervane-test-unavailable/materializer', skopeo: '/itervane-test-unavailable/skopeo' });
      equal(await observer.observe(target, image, authorize), null);
      const imported = await runner.withRetainedArchive(proof, authorize, async path => {
        await rejects(publisher.publish({ ...target, registryOrigin: 'https://other-registry.invalid' }, image, path, unreachable),
          /release_registry_drift/);
        await rejects(publisher.publish(target, { ...image, configDigest: `sha256:${sha256('different configuration')}` },
          path, authorize), /registry_tool_failed/);
        const proof = await publisher.publish(target, image, path, authorize);
        deepStrictEqual(await publisher.publish(target, image, path, authorize), proof);
        return proof;
      });
      deepStrictEqual(await readdir(staging), []);
      deepStrictEqual(await observer.observe(target, image, authorize), imported);
      await rejects(observer.observe({ ...target, registryOrigin: 'https://other-registry.invalid' }, image, unreachable), /release_registry_drift/);
      await rejects(observer.observe(target, { ...image, configDigest: `sha256:${sha256('different configuration')}` }, authorize), /registry_config_binding/);
      return { operationId, fingerprint, ...received, wrongRunnerDenied: true, wrongSizeDenied: true,
        revokedDenied: true, stagedFilesRemaining: false, registry: imported, registryReadOnly: { initiallyAbsent: true, matchedAfterCleanup: true } };
    } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmp;
      await rm(staging, { recursive: true, force: true });
    }
  } finally { await database.close(); }
}
