#!/usr/bin/env bash
set -euo pipefail

# This test provisions a throwaway account and KVM device permissions.
test "${PROBE_HOST_ENVIRONMENT:-}" = github-hosted
directory=$(realpath -- "$1")
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

path, primary, scenario, exit_code, locale = sys.argv[1:]
with open(path) as evidence:
    report = json.load(evidence)
outcome = {"0": "passed", "1": "failed", "2": "blocked"}[exit_code]
expected = [("runner-" + primary, outcome)]
if primary != "image-rejected":
    if scenario == "source":
        expected.extend((item, "passed") for item in (
            "runner-source-objects", "runner-source-egress-closed", "runner-job-cleaned",
        ))
    elif scenario != "heartbeat":
        expected.append(("runner-job-started", "passed"))
        if primary in ("job-passed", "job-input-rejected"):
            expected.append(("runner-job-receipt", "passed"))
        expected.append(("runner-job-cleaned", "passed"))
    expected.append(("runner-dedicated-session", "passed"))
    if scenario not in ("heartbeat", "source"):
        expected.append(("runner-guest-workload", "passed"))
observed = [(check["id"], check["status"]) for check in report["checks"]]
assert report["status"] == outcome and observed == expected, observed
if scenario == "source":
    # Values independently computed from the fixed main commit, not the guest.
    objects, egress = (check["detail"] for check in report["checks"][1:3])
    for value in (
        "a9276df7269444caeb61724ba490bf0387c4e3aa",
        "96a3baee0719fad7da783758d15592f1e4dc50b0",
        "789539d66651cbceb8b82079830f2559038e52b76ee7823ebdd1d88639e9e056",
        "290 个文件" if locale == "zh-CN" else "290 files",
    ):
        assert value in objects, report["checks"][1]["id"]
    assert "686b1c07b71366c6ff45e6773891ad3dbb3c6c61a03712a3be1e58331853810e" in egress
    assert ("出口关闭后的请求已被阻断。" if locale == "zh-CN" else "A request after closure was rejected.") in egress
PY
  test -z "$(as_runner find "$stage" -mindepth 1 -print -quit)"
}

capture first heartbeat en "$digest" 0 passed
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
