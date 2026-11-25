#!/usr/bin/env bash
set -euo pipefail

test "${PROBE_HOST_ENVIRONMENT:-}" = github-hosted
directory=$(realpath -- "$1")
runner_user=itervane-probe
runner_home=/home/itervane-probe
source packages/runner/ops/dedicated-session.sh

sudo -n useradd --system --user-group --groups kvm --create-home \
  --home-dir "$runner_home" --shell /usr/sbin/nologin "$runner_user"
sudo -n chmod 0700 "$runner_home"
runner_uid=$(id -u "$runner_user")
runtime="/run/user/$runner_uid"
sudo -n install -d -m 0700 -o "$runner_user" -g "$runner_user" -- "$directory/staging" "$directory/code"
sudo -n chgrp kvm /dev/kvm
sudo -n chmod 0660 /dev/kvm

# The distro's AppArmor rules govern the daemon's QEMU exec transition. The
# session is pre-started with no bounding capabilities before the NNP client.
itervane_start_libvirt "$runner_user" itervane-probe-libvirtd

error_file=$(mktemp)
trap 'rm -f -- "$error_file"' EXIT
if ! sudo -n -u "$runner_user" -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
  "XDG_RUNTIME_DIR=$runtime" "XDG_CONFIG_HOME=$runner_home/.config" "XDG_CACHE_HOME=$runner_home/.cache" \
  /usr/bin/setpriv --no-new-privs /usr/bin/virsh --connect qemu:///session domcapabilities \
    --arch x86_64 --machine q35 --virttype kvm >/dev/null 2>"$error_file"; then
  # This command probes the host's packaged emulator with a new, empty account.
  # Keep only its short diagnostic and remove ephemeral filesystem locations.
  /usr/bin/python3 - "$error_file" <<'PY'
import re
import sys

with open(sys.argv[1], encoding="utf-8", errors="replace") as stderr:
    message = stderr.read(4096)
message = re.sub(r"(?<!:)\/(?:[a-zA-Z0-9_.@%+,=-]+/?)+", "<path>", message)
message = " ".join(message.split())
print(f"Dedicated session capability probe failed: {message[:400]}")
PY
  exit 1
fi
