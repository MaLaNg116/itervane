#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# == 2 && "$2" =~ ^[0-9a-f]{64}$ ]]

inputs=$(realpath -- "$1")
fingerprint=$2
source_root=$(realpath -- "$(dirname -- "$0")/../..")
workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT
timestamp=1970-01-01T00:00:00Z

/usr/bin/python3 -B - "$source_root" "$inputs" "$fingerprint" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]) / "packages/runner/host"))
from oci_layout import verify_prepared_inputs

verify_prepared_inputs(Path(sys.argv[2]), sys.argv[3])
PY

mkdir -p -- "$workspace/content/opt/itervane"
printf '%s\n' 'Itervane OCI layer verification' > "$workspace/content/opt/itervane/proof.txt"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -cf "$workspace/layer.tar" -C "$workspace/content" opt

for attempt in first second; do
  path="$workspace/$attempt"
  cp -R -- "$inputs/base" "$path"
  "$inputs/umoci" raw add-layer --image "$path:base" --tag candidate --compress gzip \
    --history.created "$timestamp" --history.created_by 'Itervane test layer' "$workspace/layer.tar"
  "$inputs/umoci" config --image "$path:candidate" --created "$timestamp" --history.created "$timestamp" \
    --clear config.cmd --config.user 10001:10001 --config.workingdir /opt/itervane
  "$inputs/umoci" rm --image "$path:base"
  "$inputs/umoci" gc --layout "$path"
done

"$inputs/umoci" unpack --rootless --image "$workspace/first:candidate" "$workspace/bundle"
cmp -- "$workspace/content/opt/itervane/proof.txt" "$workspace/bundle/rootfs/opt/itervane/proof.txt"

/usr/bin/python3 -B - "$source_root" "$workspace" "$inputs" "$fingerprint" <<'PY'
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]) / "packages/runner/host"))
from oci_layout import verify_layout, verify_prepared_inputs

workspace, inputs = map(Path, sys.argv[2:4])
base = verify_prepared_inputs(inputs, sys.argv[4])
first = verify_layout(workspace / "first")
second = verify_layout(workspace / "second", first.manifest_digest)
assert first == second and first.manifest_digest != base.manifest_digest
assert first.layer_digests[:-1] == base.layer_digests and len(first.layer_digests) == 2
assert first.config["config"]["User"] == "10001:10001"
assert first.config["config"]["WorkingDir"] == "/opt/itervane"
print(json.dumps({
    "ociInputsSha256": sys.argv[4], "baseManifestDigest": base.manifest_digest,
    "fixtureManifestDigest": first.manifest_digest, "newLayerDigest": first.layer_digests[-1],
    "layers": len(first.layer_digests), "duplicatePreparationMatched": True,
}))
PY
