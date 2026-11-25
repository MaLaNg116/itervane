#!/usr/bin/env bash

# Shared by the reference host and the disposable hosted KVM verification.
itervane_directory() {
  local path=$1 mode=$2 user=$3 group=$4
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    sudo -n install -d -m "$mode" -o "$user" -g "$group" -- "$path" || return 1
  fi
  [[ -d "$path" && "$(realpath -e -- "$path")" = "$path" ]] || return 1
  [[ "$(sudo -n stat -c '%a %U %G' -- "$path")" = "${mode#0} $user $group" ]]
}

itervane_wait_socket() {
  local path=$1 attempt
  for attempt in {1..150}; do
    if sudo -n test -S "$path"; then return 0; fi
    sleep 0.1
  done
  return 1
}

itervane_start_libvirt() {
  local runner=$1 unit=$2 uid home runtime marker_dir marker
  uid=$(id -u -- "$runner")
  home=$(getent passwd "$runner" | cut -d: -f6)
  runtime="/run/user/$uid"
  [[ "$uid" =~ ^[1-9][0-9]*$ && "$home" = /* && "$(id -gn -- "$runner")" = "$runner" ]] || return 1
  itervane_directory "$runtime" 0700 "$runner" "$runner" || return 1
  sudo -n test ! -e "$runtime/libvirt/libvirt-sock" || return 1
  marker_dir=/run/itervane-probe-private
  marker="$marker_dir/control-plane.marker"
  itervane_directory "$marker_dir" 0711 root root || return 1
  if [[ ! -e "$marker" && ! -L "$marker" ]]; then
    sudo -n install -m 0600 -o root -g root /dev/null "$marker" || return 1
    printf '%s\n' 'synthetic host-only marker' | sudo -n tee "$marker" >/dev/null || return 1
  fi
  [[ -f "$marker" && ! -L "$marker" && "$(sudo -n stat -c '%a %U' -- "$marker")" = '600 root' ]] || return 1
  sudo -n systemd-run --quiet --unit="$unit" --uid="$runner" --gid="$runner" \
    --property=Type=exec --property=CapabilityBoundingSet= --property=AmbientCapabilities= --property=UMask=0077 \
    --setenv="XDG_RUNTIME_DIR=$runtime" --setenv="XDG_CONFIG_HOME=$home/.config" \
    --setenv="XDG_CACHE_HOME=$home/.cache" --setenv=LANG=C.UTF-8 /usr/sbin/libvirtd || return 1
  itervane_wait_socket "$runtime/libvirt/libvirt-sock"
}

itervane_check_worker() {
  local runner=$1 worker=$2 image=$3 staging=$4 runner_gid worker_gid group has_socket_group=false
  [[ "$(id -u -- "$worker")" =~ ^[1-9][0-9]*$ && "$(id -u -- "$worker")" != "$(id -u -- "$runner")" ]] || return 1
  runner_gid=$(id -g -- "$runner") || return 1
  worker_gid=$(id -g -- "$worker") || return 1
  for group in $(id -G -- "$worker"); do
    if [[ "$group" = "$runner_gid" ]]; then has_socket_group=true
    elif [[ "$group" != "$worker_gid" ]]; then return 1
    fi
  done
  [[ "$has_socket_group" = true && "$worker_gid" != "$runner_gid" && "$(id -gn -- "$worker")" = "$worker" ]] || return 1
  sudo -n -u "$worker" -- /bin/bash -c '[[ ! -r "$1" && ! -x "$2" && ! -r /dev/kvm && ! -w /dev/kvm ]]' worker "$image" "$staging"
}

itervane_start_controller() {
  local runner=$1 worker=$2 unit=$3 code=$4 sock=$5 staging=$6 image=$7 digest=$8 home attempt
  shift 8
  [[ "$digest" =~ ^[0-9a-f]{64}$ && ! -e "$sock" && ! -L "$sock" ]] || return 1
  itervane_check_worker "$runner" "$worker" "$image" "$staging" || return 1
  home=$(getent passwd "$runner" | cut -d: -f6)
  [[ "$home" = /* && "$(id -gn -- "$runner")" = "$runner" ]] || return 1
  sudo -n systemd-run --quiet --unit="$unit" --uid="$runner" --gid="$runner" \
    --property=Type=exec --property=NoNewPrivileges=yes --property=SupplementaryGroups=kvm \
    --property=CapabilityBoundingSet= --property=AmbientCapabilities= \
    --setenv="XDG_CONFIG_HOME=$home/.config" --setenv="XDG_CACHE_HOME=$home/.cache" --setenv=LANG=C.UTF-8 \
    /usr/bin/python3 -I -B "$code" "$sock" "$staging" "$image" "$digest" "$(id -u -- "$worker")" --group-socket "$@" || return 1
  itervane_wait_socket "$sock" || return 1
  # The socket is visible just after bind; wait for the Controller's final mode.
  for attempt in {1..40}; do
    if [[ "$(sudo -n stat -c '%a %U %G' -- "$sock")" = "660 $runner $runner" ]]; then return 0; fi
    sleep 0.1
  done
  return 1
}

itervane_runner_status() {
  local worker=$1 sock=$2 digest=$3
  sudo -n -u "$worker" -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -I -B - "$sock" "$digest" <<'PY'
import json
import re
import socket
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(5)
    connection.connect(sys.argv[1])
    connection.sendall(b"STATUS 1\n")
    with connection.makefile("rb") as stream:
        receipt = json.loads(stream.readline(4096))
if (
    receipt.get("kind") != "status" or receipt.get("version") != 1 or receipt.get("state") != "idle"
    or receipt.get("imageSha256") != sys.argv[2]
    or not re.fullmatch(r"[a-f0-9]{64}", receipt.get("workspaceSha256", ""))
):
    raise SystemExit("Runner is not ready for the registered worker and image")
print(json.dumps(receipt, separators=(",", ":")))
PY
}
