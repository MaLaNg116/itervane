#!/usr/bin/env bash
set -euo pipefail

test "${PROBE_HOST_ENVIRONMENT:-}" = github-hosted
directory=$(realpath -- "$1")
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
  "$sock" "$stage" "$directory/probe.raw" "$digest" "$(id -u "$worker")" https://github.com/MaLaNg116/itervane.git
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
