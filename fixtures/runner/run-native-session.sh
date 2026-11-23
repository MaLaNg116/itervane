#!/usr/bin/env bash
set -euo pipefail

# This test provisions a throwaway account and KVM device permissions.
test "${PROBE_HOST_ENVIRONMENT:-}" = github-hosted
directory=$(realpath -- "$1")
scenario=${2:-regression}
case "$scenario" in
  regression|standard-build|standard-build-missing-cache|standard-oci|protected-release|protected-release-npm|protected-release-drift|protected-release-faults|protected-release-operations|protected-release-restore|protected-release-restore-authorization|protected-release-linked-health) ;;
  *) exit 1 ;;
esac
runner_user=itervane-probe
runner_home=/home/itervane-probe
node=$(command -v node)
node_dir=$(dirname -- "$node")
pnpm=$(command -v pnpm)
reports="$PWD/.reports/p0"
stage="$directory/staging"
code="$directory/code"
sealed_image="$directory/probe.raw"
sudo -n chgrp "$runner_user" "$sealed_image"
sudo -n chmod 0440 "$sealed_image"

as_runner() {
  sudo -n -u "$runner_user" -- /usr/bin/env -i "PATH=$node_dir:/usr/bin:/bin" LANG=C.UTF-8 CI=true \
    "XDG_CONFIG_HOME=$runner_home/.config" "XDG_CACHE_HOME=$runner_home/.cache" \
    "XDG_DATA_HOME=$runner_home/.local/share" \
    /usr/bin/setpriv --no-new-privs /bin/sh -c '
      cd -- "$1" || exit 1
      shift
      exec "$@"
    ' itervane "$code" "$@"
}

# The dedicated account only receives tracked source and a fresh dependency tree.
git archive --format=tar HEAD | as_runner tar -xf -
as_runner "$pnpm" install --frozen-lockfile --ignore-scripts
as_runner /usr/bin/python3 -I -B packages/runner/host/kvm_preflight.py > "$reports/kvm-session-host.json"
/usr/bin/python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["result"] == "vm_descriptor_created"' "$reports/kvm-session-host.json"

if [[ "$scenario" != regression ]]; then
  bash fixtures/runner/run-qualified-session.sh "$directory" "$scenario"
  exit
fi

digest=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rawSha256"])' "$reports/kvm-image.json")
sudo -n install -d -m 0700 "$directory/root-stage"
sudo -n /usr/bin/python3 -I -B packages/runner/host/libvirt_probe.py \
  "$directory/root-stage" "$sealed_image" "$digest" heartbeat session > "$reports/runner-vm-rejected-privileged.json"
/usr/bin/python3 - "$reports/runner-vm-rejected-privileged.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as evidence:
    result = json.load(evidence)
assert result["code"] == "session_rejected" and result["profileIssue"] == "controller-identity", result["code"]
assert result["runId"] is None and result["sessionVerified"] is False
PY

capture() {
  local name=$1 scenario=$2 locale=$3 expected_digest=$4 expected_exit=$5 primary=$6 actual=0
  local result="$reports/runner-vm-$name.json"
  as_runner env ITERVANE_RUNNER_PROBE_MODE=session ITERVANE_RUNNER_PROBE_ROOT="$stage" \
    ITERVANE_RUNNER_PROBE_IMAGE="$sealed_image" ITERVANE_RUNNER_PROBE_IMAGE_SHA256="$expected_digest" \
    ITERVANE_RUNNER_PROBE_LOCALE="$locale" ITERVANE_RUNNER_PROBE_SCENARIO="$scenario" \
    "$node" node_modules/tsx/dist/cli.mjs packages/verification/src/entries/runner-vm.ts || actual=$?
  as_runner cat .reports/p0/runner-vm.json > "$result"
  as_runner rm -- .reports/p0/runner-vm.json
  test "$actual" -eq "$expected_exit"
  /usr/bin/python3 - "$result" "$primary" "$scenario" "$expected_exit" "$locale" <<'PY'
import json
import sys
from pathlib import Path

path, primary, scenario, exit_code, locale = sys.argv[1:]
with open(path) as evidence:
    report = json.load(evidence)
outcome = {"0": "passed", "1": "failed", "2": "blocked"}[exit_code]
expected = [("runner-" + primary, outcome)]
if primary != "image-rejected":
    if scenario in ("source", "inspect"):
        expected.extend((item, "passed") for item in (
            "runner-source-objects", "runner-source-egress-closed",
        ))
        if scenario == "inspect":
            expected.extend((item, "passed") for item in (
                "runner-inspection-snapshot", "runner-inspection-offline", "runner-inspection-gitleaks", "runner-inspection-trivy",
                "runner-repair-replay",
            ))
        expected.append(("runner-job-cleaned", "passed"))
    elif scenario != "heartbeat":
        expected.append(("runner-job-started", "passed"))
        if primary in ("job-passed", "job-input-rejected"):
            expected.append(("runner-job-receipt", "passed"))
        expected.append(("runner-job-cleaned", "passed"))
    expected.append(("runner-dedicated-session", "passed"))
    if scenario not in ("heartbeat", "source", "inspect"):
        expected.append(("runner-guest-workload", "passed"))
observed = [(check["id"], check["status"]) for check in report["checks"]]
assert report["status"] == outcome and observed == expected, observed
if scenario in ("source", "inspect"):
    # Values independently computed from the fixed main commit, not the guest.
    objects, egress = (check["detail"] for check in report["checks"][1:3])
    expected_objects = (
        "a9276df7269444caeb61724ba490bf0387c4e3aa",
        "96a3baee0719fad7da783758d15592f1e4dc50b0",
        "789539d66651cbceb8b82079830f2559038e52b76ee7823ebdd1d88639e9e056",
        "290 个文件" if locale == "zh-CN" else "290 files",
    ) if scenario == "source" else (
        "9167604c888416d7b6518e1c76485d7308cffb5c",
        "8eef89792444aea73d0aa90b87e552bbfc2d25d9",
        "9d5f74a574e8f93f95edc6be9577cd9ae7b9337777ee3cd0957ad7215e3186bb",
        "305 个文件" if locale == "zh-CN" else "305 files",
    )
    for value in expected_objects:
        assert value in objects, report["checks"][1]["id"]
    assert "686b1c07b71366c6ff45e6773891ad3dbb3c6c61a03712a3be1e58331853810e" in egress
    assert ("出口关闭后的请求已被阻断。" if locale == "zh-CN" else "A request after closure was rejected.") in egress
if scenario == "inspect":
    with Path(path).with_name("kvm-inspection-inputs.json").open() as stream:
        inputs = json.load(stream)
    snapshot, enforcement, gitleaks, trivy, repair = (check["detail"] for check in report["checks"][3:8])
    assert "87e87fe4cddfcc6cbb4ed4ed4a2a7644e79a622919fd325f17e8b5841c7b2ca7" in snapshot
    assert "1844359" in snapshot
    assert inputs["inputsSha256"] in enforcement
    assert inputs["databaseSha256"] in trivy and inputs["databaseUpdatedAt"] in trivy
    assert ("合成密钥对照通过" if locale == "zh-CN" else "passed the synthetic secret controls") in gitleaks
    assert ("锁文件对照及缺库拒绝通过" if locale == "zh-CN" else "rejected the missing database") in trivy
    # These byte digests come from git show for the fixed README and the expected added line.
    assert "127ee6ca0a857feaa9ae6fa40b1204ac9c5e87cb53ebc14c744adffb37cb4bcc" in repair
    assert "a9453f75e4f178583b4af83b02e814684e49f4b18c0e69c17a96695942a098cc" in repair
    assert ("拒绝受保护路径、过期摘要和跨字符字节区间" if locale == "zh-CN"
            else "Rejected a protected path, stale digest and split character.") in repair
PY
  test -z "$(as_runner find "$stage" -mindepth 1 -print -quit)"
}

if [[ -f "$reports/kvm-inspection-inputs.json" ]]; then
  bash fixtures/runner/run-qualified-session.sh "$directory"
fi

capture first heartbeat en "$digest" 0 passed
if [[ -f "$reports/kvm-inspection-inputs.json" ]]; then
  capture inspection inspect en "$digest" 0 inspection-passed
  capture inspection-repeat inspect zh-CN "$digest" 0 inspection-passed
fi
capture source source en "$digest" 0 source-passed
capture source-repeat source zh-CN "$digest" 0 source-passed
capture repeat heartbeat zh-CN "$digest" 0 passed
bad_digest=$(/usr/bin/python3 -c 'import sys; d=sys.argv[1]; print(("1" if d[0] == "0" else "0") + d[1:])' "$digest")
capture rejected-image heartbeat en "$bad_digest" 1 image-rejected
capture job job en "$digest" 0 job-passed
capture job-repeat job zh-CN "$digest" 0 job-passed
capture job-reject-input job-reject-input zh-CN "$digest" 1 job-input-rejected
capture job-cancel job-cancel en "$digest" 2 cancelled
capture job-timeout job-timeout zh-CN "$digest" 1 job-deadline-exceeded
