#!/usr/bin/env bash
set -euo pipefail

test "${PROBE_HOST_ENVIRONMENT:-}" = github-hosted
directory=$(realpath -- "$1")
scenario=${2:-regression}
reports="$PWD/.reports/p0"
runner=itervane-probe
worker=itervane-inspection-client
unit=itervane-qualified-controller
runtime=/run/user/$(id -u "$runner")
shared="$directory/qualified"
sock="$shared/inspection.sock"
stage="$directory/staging"
digest=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rawSha256"])' "$reports/kvm-image.json")
node=$(command -v node)
case "$scenario" in
  regression) features=(--enable-repair --enable-verification) ;;
  standard-build) features=(--enable-repair --enable-verification --enable-standard-build --enable-standard-baseline) ;;
  standard-oci|protected-release|protected-release-npm|protected-release-drift|protected-release-faults|protected-release-operations|protected-release-restore|protected-release-restore-authorization)
    artifacts="$directory/artifacts"
    sudo -n install -d -m 0700 -o "$runner" -g "$runner" "$artifacts"
    features=(--enable-repair --enable-verification --enable-standard-build --enable-standard-baseline --enable-standard-oci --artifact-store "$artifacts")
    ;;
  standard-build-missing-cache) features=(--enable-verification --enable-standard-build) ;;
  *) exit 1 ;;
esac

sudo -n useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$worker"
sudo -n install -d -m 0755 -o "$runner" -g "$runner" "$shared"
pnpm exec esbuild scripts/probe-qualified-runner.ts --bundle --platform=node --format=esm --target=node24 \
  --outfile=.reports/p0/qualified-client.mjs
sudo -n install -m 0444 .reports/p0/qualified-client.mjs "$shared/client.mjs"

sudo -n systemd-run --quiet --unit="$unit" --uid="$runner" --gid="$runner" \
  --property=Type=exec --property=NoNewPrivileges=yes --property=SupplementaryGroups=kvm \
  --property=CapabilityBoundingSet= --property=AmbientCapabilities= \
  --setenv="XDG_CONFIG_HOME=/home/$runner/.config" --setenv="XDG_CACHE_HOME=/home/$runner/.cache" --setenv=LANG=C.UTF-8 \
  /usr/bin/python3 -I -B "$directory/code/packages/runner/host/qualified_controller.py" \
  "$sock" "$stage" "$directory/probe.raw" "$digest" "$(id -u "$worker")" "${features[@]}" https://github.com/MaLaNg116/itervane.git
trap 'sudo -n systemctl stop "$unit"' EXIT
for attempt in {1..100}; do
  if sudo -n test -S "$sock"; then break; fi
  sleep 0.1
done
sudo -n test -S "$sock"
sudo -n chgrp "$worker" "$sock"
sudo -n chmod 0660 "$sock"

as_client() {
  sudo -n -u "$worker" -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
    /usr/bin/setpriv --no-new-privs "$node" "$shared/client.mjs" "$sock" "$(id -u "$runner")" "$digest" "$@"
}

domains() {
  sudo -n -u "$runner" -- /usr/bin/env -i "XDG_RUNTIME_DIR=$runtime" PATH=/usr/bin:/bin LANG=C.UTF-8 \
    /usr/bin/virsh --connect qemu:///session list --name "$@"
}

assert_empty() {
  local active staged
  active=$(domains --all) || return 1
  staged=$(sudo -n find "$stage" -mindepth 1 -print -quit) || return 1
  [[ -z "$active" && -z "$staged" ]]
}

if [[ "$scenario" == regression ]]; then
sudo -n /usr/bin/python3 -I -B - "$sock" > "$reports/runner-qualified-peer.json" <<'PY'
import json
import socket
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(4)
    client.connect(sys.argv[1])
    with client.makefile("rb") as stream:
        outcome = json.loads(stream.readline(2048))
assert outcome == {"kind": "rejected", "requestId": None, "code": "peer_denied", "cleanup": "not_started", "domainId": None}
print(json.dumps(outcome))
PY
as_client origin > "$reports/runner-qualified-origin.json"
as_client no-lease > "$reports/runner-qualified-no-lease.json"
assert_empty
as_client scan > "$reports/runner-qualified-scan.json"
assert_empty
as_client repair < "$reports/runner-qualified-scan.json" > "$reports/runner-qualified-repair.json"
assert_empty

for mode in revoke disconnect; do
  trigger="$shared/$mode.stop"
  as_client "$mode" "$trigger" > "$reports/runner-qualified-$mode.json" &
  child=$!
  domain=
  for attempt in {1..300}; do
    domain=$(domains --state-running)
    if [[ "$domain" =~ ^itervane-d2-[0-9a-f-]{36}$ ]] && sudo -n test -s "$runtime/libvirt/qemu/run/$domain.pid"; then
      break
    fi
    kill -0 "$child"
    sleep 0.2
  done
  [[ "$domain" =~ ^itervane-d2-[0-9a-f-]{36}$ ]]
  pid=$(sudo -n cat "$runtime/libvirt/qemu/run/$domain.pid")
  # Open the actual QEMU pidfd before signalling release of the client's lease.
  sudo -n /usr/bin/python3 -I -B - "$pid" "$domain" "$trigger" <<'PY'
import os
import select
import sys
from pathlib import Path

pid = int(sys.argv[1])
domain_id = sys.argv[2].removeprefix("itervane-d2-").encode()
fd = os.pidfd_open(pid)
try:
    argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    assert b"qemu-system-x86_64" in argv[0] and (b"-uuid", domain_id) in zip(argv, argv[1:])
    with Path(sys.argv[3]).open("xb") as trigger:
        os.fchmod(trigger.fileno(), 0o444)
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    assert poll.poll(25000), "QEMU did not exit after the verified client's lease ended"
finally:
    os.close(fd)
PY
  wait "$child"
  for attempt in {1..60}; do
    if assert_empty; then break; fi
    sleep 0.2
  done
  assert_empty
  if [[ "$mode" == disconnect ]]; then
    printf '{"kind":"disconnect","domainId":"%s","processExited":true,"stagingEmpty":true}\n' \
      "${domain#itervane-d2-}" > "$reports/runner-qualified-disconnect.json"
  else
    /usr/bin/python3 - "$reports/runner-qualified-revoke.json" "${domain#itervane-d2-}" <<'PY'
import json
import sys
with open(sys.argv[1]) as report:
    outcome = json.load(report)
assert outcome["domainId"] == sys.argv[2] and outcome["cleanup"] == "confirmed"
PY
  fi
done
fi

pnpm exec esbuild packages/control-plane/src/entries/worker.ts --bundle --platform=node --format=esm --target=node24 \
  '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile=.reports/p0/qualified-worker.mjs
sudo -n install -m 0444 .reports/p0/qualified-worker.mjs "$shared/worker.mjs"
pnpm exec esbuild packages/control-plane/test/native/worker-repair.ts --bundle --platform=node --format=esm --target=node24 \
  '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile=.reports/p0/repair-worker.mjs
sudo -n install -m 0444 .reports/p0/repair-worker.mjs "$shared/repair-worker.mjs"
pnpm exec esbuild packages/control-plane/test/native/worker-verification.ts --bundle --platform=node --format=esm --target=node24 \
  '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile=.reports/p0/verification-worker.mjs
sudo -n install -m 0444 .reports/p0/verification-worker.mjs "$shared/verification-worker.mjs"
if [[ "$scenario" == standard-oci || "$scenario" == protected-release* ]]; then
  sudo -n install -d -m 0755 "$shared/release-tools"
  sudo -n install -m 0444 packages/runner/host/{materialize_oci,oci_layout,oci_artifacts,source_wire,guest_job}.py "$shared/release-tools/"
fi
if [[ "$scenario" == protected-release* ]]; then
  pnpm exec esbuild packages/control-plane/src/entries/release-worker.ts --bundle --platform=node --format=esm --target=node24 \
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
    --outfile=.reports/p0/qualified-release-worker.mjs
  sudo -n install -m 0444 .reports/p0/qualified-release-worker.mjs "$shared/release-worker.mjs"
fi
if [[ "$scenario" == protected-release-operations ]]; then
  pnpm exec esbuild packages/control-plane/src/entries/restart-worker.ts --bundle --platform=node --format=esm --target=node24 \
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
    --outfile=.reports/p0/qualified-restart-worker.mjs
  sudo -n install -m 0444 .reports/p0/qualified-restart-worker.mjs "$shared/restart-worker.mjs"
fi
if [[ "$scenario" == protected-release-restore* ]]; then
  pnpm exec esbuild packages/control-plane/src/entries/restore-worker.ts --bundle --platform=node --format=esm --target=node24 \
    '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
    --outfile=.reports/p0/qualified-restore-worker.mjs
  sudo -n install -m 0444 .reports/p0/qualified-restore-worker.mjs "$shared/restore-worker.mjs"
fi
if [[ "$scenario" == protected-release-drift ]]; then
  sudo -n install -m 0444 fixtures/runner/release-drift-archive.py "$shared/release-tools/release-drift-archive.py"
fi
extra=()
report="$reports/runner-worker-inspection.json"
if [[ "$scenario" != regression ]]; then
  profile=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildProfileSha256"])' "$reports/kvm-build-inputs.json")
  baseline=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["baselineSha256"])' "$reports/kvm-build-inputs.json")
  extra=("$scenario" "$profile" "$baseline")
  if [[ "$scenario" == standard-oci || "$scenario" == protected-release* ]]; then
    oci=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ociInputsSha256"])' "$reports/kvm-oci-inputs.json")
    extra+=("$oci")
  fi
  report="$reports/runner-worker-build.json"
fi
if [[ "$scenario" == protected-release* ]]; then
  report="$reports/runner-protected-release.json"
fi
pnpm exec tsx packages/control-plane/test/native/worker-inspection.ts "$shared/worker.mjs" "$sock" "$(id -u "$runner")" "$digest" "$stage" \
  "$shared/repair-worker.mjs" "$shared/verification-worker.mjs" "${extra[@]}" \
  > "$report"
assert_empty

if [[ "$scenario" == standard-oci || "$scenario" == protected-release* ]]; then
  sudo -n install -m 0444 fixtures/runner/verify-stored-oci.py "$shared/verify-stored-oci.py"
  check_archive() {
    local case_path=$1 output=$2 archive_sha archive_bytes expected_manifest archive measured_manifest
    read -r archive_sha archive_bytes expected_manifest < <(/usr/bin/python3 - "$report" "$case_path" <<'PY'
import json
import re
import sys
with open(sys.argv[1]) as stream:
    proof = json.load(stream)
for key in sys.argv[2].split("."):
    proof = proof[key]
receipt = proof["build"]["baseline"]["image"]
archive = receipt["archive"]
assert proof["archiveVerification"]["archive"] == archive
assert re.fullmatch(r"[a-f0-9]{64}", archive["sha256"])
assert re.fullmatch(r"sha256:[a-f0-9]{64}", receipt["manifestDigest"])
assert type(archive["bytes"]) is int and 0 < archive["bytes"] <= 200 * 1024**2
print(archive["sha256"], archive["bytes"], receipt["manifestDigest"])
PY
)
    archive="$artifacts/$archive_sha.oci.tar"
    test "$(sudo -n -u "$runner" stat -c '%s %a' -- "$archive")" = "$archive_bytes 400"
    test "$(sudo -n -u "$runner" sha256sum -- "$archive" | cut -d ' ' -f 1)" = "$archive_sha"
    measured_manifest=$(sudo -n -u "$runner" /usr/bin/python3 -I -B "$shared/verify-stored-oci.py" "$archive" "$expected_manifest")
    test "$measured_manifest" = "$expected_manifest"
    printf '{"archiveSha256":"%s","bytes":%s,"manifestDigest":"%s","workspaceAndStagingEmpty":true}\n' \
      "$archive_sha" "$archive_bytes" "$measured_manifest" > "$output"
  }
  archive_reports=("$reports/runner-oci-artifact.json")
  if [[ "$scenario" == protected-release-drift ]]; then
    check_archive drift.targetBuild "${archive_reports[0]}"
    archive_reports+=("$reports/runner-drift-oci-artifact.json")
    check_archive drift.archiveBuild "${archive_reports[1]}"
  elif [[ "$scenario" == protected-release-faults ]]; then
    check_archive faults.health.after "${archive_reports[0]}"
    archive_reports+=("$reports/runner-faults-oci-artifact.json")
    check_archive faults.identity.after "${archive_reports[1]}"
  elif [[ "$scenario" == protected-release-restore* ]]; then
    check_archive dualVersion.first.build "${archive_reports[0]}"
    archive_reports+=("$reports/runner-restore-oci-artifact.json")
    check_archive dualVersion.second.build "${archive_reports[1]}"
  elif [[ "$scenario" == protected-release* ]]; then
    archive_path=retry.after
    if [[ "$scenario" == protected-release-npm ]]; then archive_path=dependency.after; fi
    check_archive "$archive_path" "${archive_reports[0]}"
  else
    check_archive built "${archive_reports[0]}"
    archive_reports+=("$reports/runner-retry-oci-artifact.json")
    check_archive retry.after "${archive_reports[1]}"
  fi
  expected_count=$(/usr/bin/python3 - "${archive_reports[@]}" <<'PY'
import json
import sys
hashes = set()
for path in sys.argv[1:]:
    with open(path) as stream:
        hashes.add(json.load(stream)["archiveSha256"])
print(len(hashes))
PY
)
  test "$(sudo -n -u "$runner" find "$artifacts" -maxdepth 1 -type f -name '*.oci.tar' -printf '.' | wc -c)" -eq "$expected_count"
  test -z "$(sudo -n -u "$runner" find "$artifacts" -maxdepth 1 \( -name '.pending-*' -o -name '.fixture-held-*' \) -print -quit)"
fi
