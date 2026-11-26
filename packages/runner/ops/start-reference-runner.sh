#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -lt 6 || $# -gt 21 || "$EUID" -ne 0 || "$(uname -m)" != x86_64 || "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'Usage as root: start-reference-runner.sh STATE IMAGE SHA256 RUNNER WORKER HTTPS_ORIGIN...' >&2
  exit 2
fi
if [[ ! -c /dev/kvm ]]; then
  printf '%s\n' 'A Linux KVM device is required for the reference Runner.' >&2
  exit 1
fi
ops=$(dirname -- "$(realpath -e -- "$0")")
source "$ops/dedicated-session.sh"
session_unit=itervane-reference-libvirt.service
controller_unit=itervane-reference-runner.service
session_started=false
controller_started=false
phase=image_path

finish_installation() {
  local result=$?
  if [[ "$result" -eq 0 ]]; then return; fi
  printf 'Reference Runner installation failed during %s.\n' "$phase" >&2
  if [[ "$controller_started" = true ]]; then systemctl stop "$controller_unit" >/dev/null 2>&1 || true; fi
  if [[ "$session_started" = true ]]; then systemctl stop "$session_unit" >/dev/null 2>&1 || true; fi
}
trap finish_installation EXIT

state=$(realpath -m -- "$1")
image=$(realpath -e -- "$2")
digest=$3
runner=$4
worker=$5
[[ "$state" = "$1" && "$state" != / && "$image" = "$2" && -f "$image" ]]
[[ "$runner" =~ ^[a-z][a-z0-9_-]{0,30}$ && "$worker" =~ ^[a-z][a-z0-9_-]{0,30}$ && "$digest" =~ ^[0-9a-f]{64}$ ]]
shift 5
phase=image_ownership
[[ "$(stat -c '%a %U %G' -- "$image")" = '440 root kvm' ]]
phase=image_digest
printf '%s  %s\n' "$digest" "$image" | sha256sum --status --check

phase=state_directory
itervane_directory "$state" 0711 root root
phase=installation_lock
management=/run/itervane-reference-manager
itervane_directory "$management" 0700 root root
exec 9>"$management/install.lock"
flock -n 9
if systemctl is-active --quiet "$session_unit" "$controller_unit"; then
  printf '%s\n' 'The reference Runner is already running.' >&2
  exit 1
fi

staging="$state/staging"
artifacts="$state/artifacts"
code="$state/host"
control=/run/itervane-reference-runner
socket="$control/inspection.sock"
phase=runtime_directories
itervane_directory "$staging" 0700 "$runner" "$runner"
itervane_directory "$artifacts" 0700 "$runner" "$runner"
itervane_directory "$code" 0755 root root
itervane_directory "$control" 0755 "$runner" "$runner"
phase=worker_access
itervane_check_worker "$runner" "$worker" "$image" "$staging"
phase=controller_files
[[ ! -e "$socket" && ! -L "$socket" ]]
for module in "$ops"/../host/*.py; do
  filename=$(basename -- "$module")
  [[ "$filename" != test_* ]] || continue
  install -m 0444 -o root -g root -- "$module" "$code/$filename"
done

phase=libvirt_session
session_started=true
itervane_start_libvirt "$runner" "$session_unit"
phase=runner_controller
controller_started=true
itervane_start_controller "$runner" "$worker" "$controller_unit" "$code/qualified_controller.py" "$socket" \
  "$staging" "$image" "$digest" --enable-repair --enable-verification --enable-standard-build --enable-standard-baseline \
  --enable-standard-oci --enable-rule-samples --artifact-store "$artifacts" "$@"
phase=worker_status
itervane_runner_status "$worker" "$socket" "$digest" >/dev/null
printf 'ITERVANE_RUNNER_SOCKET=%s\nITERVANE_RUNNER_UID=%s\nITERVANE_RUNNER_IMAGE_SHA256=%s\n' \
  "$socket" "$(id -u -- "$runner")" "$digest"
