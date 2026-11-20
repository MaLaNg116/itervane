#!/usr/bin/env bash
set -euo pipefail
umask 077

work=$(realpath -- "$1")
image_base='https://cloud-images.ubuntu.com/releases/noble/release-20261017'
ubuntu_pool='https://archive.ubuntu.com/ubuntu/pool'
base_digest='04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94'
agent_digest='62abf54bf34fed34dc65cbd973b4b6b6f4685fef30fbaa3fb3e8865e957fda75'
uring_digest='c2aef62accee92a06263c3ad4ef46132c13e409b54296c44792a20491830a7b0'
recipe_dir=$(dirname -- "$(realpath -- "$0")")
downloads="$work/downloads"
mkdir -- "$downloads"

download() {
  local url=$1 digest=$2 path=$3 limit=$4
  curl --silent --show-error --fail --location --retry 2 --max-time 240 \
    --proto '=https' --proto-redir '=https' --max-filesize "$limit" --output "$path" "$url"
  printf '%s  %s\n' "$digest" "$path" | sha256sum --check --status
}

download "$image_base/ubuntu-24.04-server-cloudimg-amd64.img" \
  "$base_digest" "$downloads/base.qcow2" 1073741824
download "$ubuntu_pool/universe/q/qemu/qemu-guest-agent_8.2.2+ds-0ubuntu1.18_amd64.deb" \
  "$agent_digest" "$downloads/agent.deb" 2097152
download "$ubuntu_pool/main/libu/liburing/liburing2_2.5-1build1_amd64.deb" \
  "$uring_digest" "$downloads/liburing.deb" 2097152

qemu-img info -f qcow2 --output=json "$downloads/base.qcow2" \
  | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if 0 < d["virtual-size"] <= 8*1024**3 and "backing-filename" not in d else 1)'

# The verified Ubuntu image is customized with only the two verified packages.
# The libguestfs appliance and the final lifecycle guest have no network.
LIBGUESTFS_BACKEND=direct virt-customize --no-network --no-logfile --format qcow2 \
  -a "$downloads/base.qcow2" \
  --upload "$downloads/agent.deb:/var/tmp/itervane-probe-agent.deb" \
  --upload "$downloads/liburing.deb:/var/tmp/itervane-probe-liburing.deb" \
  --run "$recipe_dir/configure-probe-guest.sh"

qemu-img convert -f qcow2 -O raw "$downloads/base.qcow2" "$work/probe.raw"
/usr/bin/python3 -I -B - "$work" "$base_digest" "$agent_digest" "$uring_digest" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
image = root / "probe.raw"
size = image.stat().st_size
if not 0 < size <= 8 * 1024**3 or size % 512:
    raise SystemExit("Unexpected raw image size")
with image.open("rb") as contents:
    digest = hashlib.file_digest(contents, "sha256").hexdigest()
with (root / "image.json").open("x") as evidence:
    json.dump({
        "schema": 1,
        "baseRelease": "ubuntu-noble-20261017",
        "baseSha256": sys.argv[2],
        "guestAgentDebSha256": sys.argv[3],
        "liburingDebSha256": sys.argv[4],
        "rawSha256": digest,
        "rawBytes": size,
    }, evidence, indent=2)
    evidence.write("\n")
PY
