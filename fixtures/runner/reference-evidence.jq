def independent($count; $pattern):
  length == $count and (unique | length) == $count
  and all(.[]; type == "string" and test($pattern));

def digest: "^[a-f0-9]{64}$";
def uuid: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
def positive_integer: type == "number" and . > 0 and (floor == .);
def recorded_usage:
  type == "object" and ([.turns, .toolCalls, .tokens] | all(.[]; positive_integer)) and .toolCalls <= .turns;

def measured($development; $operations):
  $development.measurements as $delivery |
  $development.model == "scripted_anthropic_fixture" and $operations.model == "scripted_anthropic_fixture"
  and ([$delivery.deliveryDurationMs, $delivery.databaseBytes, $delivery.archiveBytes, $operations.recoveryDurationMs] |
    all(.[]; positive_integer))
  and $delivery.findings == {introduced: 0, resolved: 1, remaining: 0}
  and ([$delivery.auditUsage, $delivery.repairUsage, $delivery.verificationUsage, $operations.diagnosisUsage] |
    all(.[]; recorded_usage));

def qualified:
  .development as $d | $d.operations as $o |
  .sourceTree == $tree and .cleanInstallation == true and .qualifiedRunner == true
  and .workspaceAndStagingEmpty == true and .browserPkce == true and .externalMcpPkce == true
  and .mcpScopeAndAudienceVerified == true and .initializedTwice == true and .locales == ["en", "zh-CN"]
  and $d.controlPlaneIdentity == "native_keycloak" and $d.portalApproval == true
  and $d.mcpApprovalDenied == true and $d.operationObserved == true and $d.healthStatus == 200
  and ($d.anonymousStatus == 401 or $d.anonymousStatus == 403)
  and $o.releaseOperationId == $d.operationId and $o.admissions == 1 and $o.portalApproval == true
  and $o.nativeApproval == true and $o.independentReader == true and $o.incidentRecovered == true
  and $o.executionSlotReleased == true and $o.httpMcpAgreement == true and $o.healthStatus == 200
  and ($o.anonymousStatus == 401 or $o.anonymousStatus == 403)
  and measured($d; $o);

sort_by(.scenario)
| if ($tree | test("^[a-f0-9]{40}$")) and ($workflow | test("^[0-9]+$"))
    and map(.scenario) == ["reference-development-1", "reference-development-2", "reference-development-3"]
    and all(.[]; qualified)
    and (map(.development.projectId) | independent(3; uuid))
    and (map(.development | .taskId, .operations.taskId) | independent(6; uuid))
    and (map(.development | .runId, .operations.runId) | independent(6; uuid))
    and (map(.development | .inspectionGuestId, .verificationGuestId) | independent(6; uuid))
    and (map(.development.candidateId) | independent(3; uuid))
    and (map(.development.operationId) | independent(3; uuid))
    and (map(.development.updateId) | independent(3; "^[a-f0-9]{24}$"))
    and (map(.development.operations.incidentId) | independent(3; uuid))
    and (map(.development.operations.executionId) | independent(3; uuid))
    and (map(.development.operations.approvalId) | independent(3; "^[a-f0-9]{32}$"))
    and (map(.development.operations.recoverySha256) | independent(3; digest))
  then {
    version: 2, sourceTree: $tree, workflowRun: $workflow, developmentRuns: 3, operationsRuns: 3,
    model: {mode: "scripted_anthropic_fixture", externalProviderRequests: 0},
    runs: map({
      scenario, projectId: .development.projectId, developmentTaskId: .development.taskId,
      inspectionGuestId: .development.inspectionGuestId, verificationGuestId: .development.verificationGuestId,
      releaseOperationId: .development.operationId, updateId: .development.updateId,
      operationsTaskId: .development.operations.taskId, incidentId: .development.operations.incidentId,
      approvalId: .development.operations.approvalId, executionId: .development.operations.executionId,
      recoverySha256: .development.operations.recoverySha256,
      measurements: (.development.measurements + {
        recoveryDurationMs: .development.operations.recoveryDurationMs,
        diagnosisUsage: .development.operations.diagnosisUsage
      })
    })
  }
  else error("reference run evidence is incomplete, inconsistent or reused")
  end
