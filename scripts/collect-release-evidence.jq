def sha256: type == "string" and test("^[a-f0-9]{64}$");
def refused: . == 401 or . == 403;
def run_link($id): "https://github.com/" + $repo + "/actions/runs/" + $id;

$manifest[0] as $m | $packages[0] as $p | $installed[0] as $i | $regression[0] as $g |
$upgrade[0] as $u | $repeated[0] as $repeat | $development[0].development.operations as $operations |
$operations.runbook as $runbook | $code[0].development.healthCodeRule as $rule |
$restore[0].development.versionRestore as $version | $backup[0].backup as $b | $stored[0] as $a |
$backup[0].operations.restart as $restart | $fault[0].faults as $failure |
if ([$manifest, $packages, $installed, $regression, $upgrade, $repeated, $development, $code, $restore, $backup, $stored, $fault] |
      all(.[]; length == 1))
    and $m.commit == $commit and $m.tree == $tree and $m.release == $release
    and $m.toolchain.platform == "linux" and $m.toolchain.architecture == "x64" and $m.toolchain == $p.toolchain
    and $m.lockfile.sha256 == $lockfile and $m.componentNotices == "docs/release-components.md"
    and ([$m.files[] | .sha256] | sort) == ([$archive, $licenses] | sort)
    and ($p.packages | length > 0 and all(.[]; [.name, .version, .license] | all(.[]; type == "string" and length > 0)))
    and $i.archiveSha256 == $archive and $i.sourceTree == $tree and $i.cleanInstallation == true and $i.taskHeldForRunner == true
    and $i.browserPkce == true and $i.externalMcpPkce == true and $i.ownerPasswordChanged == true and $i.locales == ["en", "zh-CN"]
    and $g.sourceTree == $tree and $g.integration.passed > 0 and $g.integration.failed == 0 and
      $g.deterministic == {typesAndUnit: true, runnerHost: true, healthProbe: true, appBackup: true, mcp: true, fixture: true}
    and $u.sourceTree == $tree and $u.postgresMajor == 17 and $u.initializedTwice == true and $u.upgrade.restrictedRuntime == true
    and $u.upgrade.queuedJobPreserved == true and $u.upgrade.priorOwnerRetained == true and $u.upgrade.legacyTaskConsumedWithRunnerGate == true
    and $u.upgrade.idempotentReplay == true and $u.upgrade.appliedMigrations > $u.upgrade.formerMigrations and ($u.upgrade.migrationLedgerSha256 | sha256)
    and $repeat.sourceTree == $tree and $repeat.version == 2 and $repeat.workflowRun == $native
    and $repeat.developmentRuns == 3 and $repeat.operationsRuns == 3 and ($repeat.runs | length == 3)
    and $development[0].sourceTree == $tree and $operations.recoverySha256 == $runbook.recoverySha256
    and $runbook.reused.incidentId != $operations.incidentId and $runbook.reused.incidentRecovered == true
    and $runbook.reused.nativeApproval == true and ($runbook.reused.ruleSnapshotSha256 | sha256)
    and $runbook.publication.sequence == 1 and ($runbook.publication.versionSha256 | sha256)
    and $code[0].sourceTree == $tree and $rule.before.status == 503 and $rule.after.status == 200
    and $rule.reused.violation.blocked == true and $rule.reused.violation.findings == 1 and $rule.reused.clean.findings == 0
    and $rule.reused.clean.waitingApproval == true and ($rule.learned.publication.versionSha256 | sha256)
    and $version.previous.operationId == $version.restored.operationId and ($version.recoverySha256 | sha256)
    and $b.sourcePostgres == $b.targetPostgres and ($b.targetPostgres | startswith("17."))
    and $b.tables > 0 and $b.configFiles == 3 and $b.archives >= 1 and ($b.manifestSha256 | sha256)
    and $b.releaseOperationId == $backup[0].release.operationId and $b.manifestDigest == $backup[0].release.manifestDigest
    and $b.archive.sha256 == $a.archiveSha256 and $b.archive.bytes == $a.bytes and $b.archive.bytes > 0
    and $b.recoveryEvidenceSha256 == $restart.reused.proofSha256 and $b.unconfirmedEvidenceSha256 == $restart.interrupted.proofSha256
    and $b.ruleVersionSha256 == $restart.ruleExtraction.publication.versionSha256 and $b.ruleSnapshotSha256 == $restart.reused.runbook.snapshotSha256
    and $b.nativeUnconfirmedRetained == true and $b.reconciled == false and ($b.anonymousDuringBackup | refused) and ($b.anonymousAfterRestore | refused)
    and $failure.health.reason == "release_rollout_health_failed" and $failure.identity.reason == "release_rollout_unavailable"
    and ([$failure.health, $failure.identity] | all(.[]; .environmentHeld == true and .recovery.writes == 1 and (.anonymousStatus | refused)))
then {
  schemaVersion: 1, release: $release, commit: $commit, sourceTree: $tree,
  workflows: {verification: run_link($verification), native: run_link($native), source: run_link($source)},
  installer: {archiveSha256: $archive, dependencyLicensesSha256: $licenses, lockfileSha256: $lockfile,
    dependencyPackages: ($p.packages | length), toolchain: $m.toolchain, locales: $i.locales},
  regression: {postgres: $g.postgres, integration: $g.integration, deterministic: $g.deterministic,
    nativeFaults: [$failure.health.reason, $failure.identity.reason]},
  repeated: $repeat,
  reuse: {codeVersionSha256: $rule.learned.publication.versionSha256, runbookVersionSha256: $runbook.publication.versionSha256,
    runbookSnapshotSha256: $runbook.reused.ruleSnapshotSha256},
  targetVersionRestore: {version: $version.restored.version, proofSha256: $version.recoverySha256, healthStatus: $version.healthStatus},
  databaseUpgrade: $u.upgrade,
  backup: {postgres: $b.targetPostgres, tables: $b.tables, configs: $b.configFiles, archives: $b.archives,
    archiveBytes: $b.archive.bytes, archiveSha256: $b.archive.sha256, manifestSha256: $b.manifestSha256,
    ambiguousEffectRetained: $b.nativeUnconfirmedRetained, anonymousDuringBackup: $b.anonymousDuringBackup,
    anonymousAfterRestore: $b.anonymousAfterRestore}
}
else error("release receipts are incomplete or refer to different source, artifacts, or results") end
