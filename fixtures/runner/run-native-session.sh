#!/usr/bin/env bash
set -euo pipefail

# This test provisions a throwaway account and KVM device permissions.
test "${PROBE_HOST_ENVIRONMENT:-}" = github-hosted
directory=$(realpath -- "$1")
runner_user=itervane-probe
node=$(command -v node)
node_dir=$(dirname -- "$node")
pnpm=$(command -v pnpm)
reports="$PWD/.reports/p0"
stage="$directory/staging"
code="$directory/code"
sealed_image="$directory/probe.raw"
marker_dir=/run/itervane-probe-private

sudo -n useradd --system --user-group --groups kvm --create-home \
  --home-dir "$directory/account" --shell /usr/sbin/nologin "$runner_user"
runner_uid=$(id -u "$runner_user")
sudo -n install -d -m 0700 -o "$runner_user" -g "$runner_user" -- "$stage" "$code" "/run/user/$runner_uid"
sudo -n chgrp "$runner_user" "$sealed_image"
sudo -n chmod 0440 "$sealed_image"
sudo -n chgrp kvm /dev/kvm
sudo -n chmod 0660 /dev/kvm
sudo -n mkdir -m 0711 "$marker_dir"
sudo -n install -m 0600 /dev/null "$marker_dir/control-plane.marker"
printf '%s\n' 'synthetic host-only marker' | sudo -n tee "$marker_dir/control-plane.marker" >/dev/null

as_runner() {
  sudo -n -u "$runner_user" -- /usr/bin/env -i "PATH=$node_dir:/usr/bin:/bin" LANG=C.UTF-8 CI=true \
    "XDG_CONFIG_HOME=$directory/account/.config" "XDG_CACHE_HOME=$directory/account/.cache" \
    "XDG_DATA_HOME=$directory/account/.local/share" \
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
  /usr/bin/python3 - "$result" "$primary" "$scenario" "$expected_exit" <<'PY'
import json
import sys

path, primary, scenario, exit_code = sys.argv[1:]
with open(path) as evidence:
    report = json.load(evidence)
outcome = {"0": "passed", "1": "failed", "2": "blocked"}[exit_code]
expected = [("runner-" + primary, outcome)]
if primary != "image-rejected":
    if scenario != "heartbeat":
        expected.append(("runner-job-started", "passed"))
        if primary in ("job-passed", "job-input-rejected"):
            expected.append(("runner-job-receipt", "passed"))
        expected.append(("runner-job-cleaned", "passed"))
    expected.append(("runner-dedicated-session", "passed"))
    if scenario != "heartbeat":
        expected.append(("runner-guest-workload", "passed"))
observed = [(check["id"], check["status"]) for check in report["checks"]]
assert report["status"] == outcome and observed == expected, observed
PY
  test -z "$(as_runner find "$stage" -mindepth 1 -print -quit)"
}

capture first heartbeat en "$digest" 0 passed
capture repeat heartbeat zh-CN "$digest" 0 passed
bad_digest=$(/usr/bin/python3 -c 'import sys; d=sys.argv[1]; print(("1" if d[0] == "0" else "0") + d[1:])' "$digest")
capture rejected-image heartbeat en "$bad_digest" 1 image-rejected
capture job job en "$digest" 0 job-passed
capture job-repeat job zh-CN "$digest" 0 job-passed
capture job-reject-input job-reject-input zh-CN "$digest" 1 job-input-rejected
capture job-cancel job-cancel en "$digest" 2 cancelled
capture job-timeout job-timeout zh-CN "$digest" 1 job-deadline-exceeded
