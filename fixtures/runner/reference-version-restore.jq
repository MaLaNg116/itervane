def ids: all(.[]; type == "string" and test("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"));
def hashes: all(.[]; type == "string" and test("^[a-f0-9]{64}$"));

.development.versionRestore as $restore
| .sourceTree == $tree and .scenario == "reference-version-restore"
  and .cleanInstallation == true and .qualifiedRunner == true and .workspaceAndStagingEmpty == true
  and .browserPkce == true and .externalMcpPkce == true and .mcpScopeAndAudienceVerified == true and .locales == ["en", "zh-CN"]
  and $restore.model == "scripted_anthropic_fixture"
  and $restore.pendingDenied == true and $restore.mcpSubmissionDenied == true and $restore.portalApproval == true
  and $restore.independentReader == true and $restore.bilingualPortalAndMcp == true and $restore.executionSlotReleased == true
  and $restore.sendFence > 0 and $restore.readFence > $restore.sendFence
  and $restore.healthStatus == 200 and ($restore.anonymousStatus == 401 or $restore.anonymousStatus == 403)
  and ($restore.restored.version | test("^candidate-[a-f0-9]{16}$"))
  and ($restore.restored.updateId | test("^[a-f0-9]{24}$")) and ($restore.deploymentId | test("^[a-f0-9]{24}$"))
  and ($restore.previousRevision | test("^[a-f0-9]{40}$")) and ($restore.currentRevision | test("^[a-f0-9]{40}$"))
  and $restore.previousRevision != $restore.currentRevision
  and $restore.current.operationId != $restore.previous.operationId
  and $restore.current.manifestDigest != $restore.previous.manifestDigest
  and ([$restore.current.manifestDigest, $restore.previous.manifestDigest] | all(.[]; test("^sha256:[a-f0-9]{64}$")))
  and $restore.restored.operationId == $restore.previous.operationId
  and $restore.restored.manifestDigest == $restore.previous.manifestDigest
  and $restore.restored.containerId != $restore.currentContainerId
  and ([$restore.environmentId, $restore.taskId, $restore.runId, $restore.executionId,
    $restore.current.operationId, $restore.previous.operationId] | ids and (length == (unique | length)))
  and ([$restore.mappingSha256, $restore.diagnosisSha256, $restore.proposalSha256, $restore.planSha256, $restore.recoverySha256,
    $restore.currentContainerId, $restore.restored.containerId] | hashes)
