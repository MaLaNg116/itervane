#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# == 1 && "$(uname -sm)" == "Linux x86_64" ]]
[[ "$(basename -- "$1")" == itervane-oci-inputs ]]
parent=$(realpath -- "$(dirname -- "$1")")
destination="$parent/itervane-oci-inputs"
[[ ! -e "$destination" && ! -L "$destination" ]]
temporary=$(mktemp -d -- "$parent/.oci-inputs.XXXXXX")
trap 'rm -rf -- "$temporary"' EXIT
payload="$temporary/payload"
mkdir -- "$payload"

recipe=$(dirname -- "$(realpath -- "$0")")
repository=docker.io/library/ubuntu
mirror=mirror.gcr.io/library/ubuntu
upstream=sha256:9a04f13b3f80ef056361e30868593b1cfd2279fe19e4081cb93a90bf56819d6a
config=sha256:2b147973fd863c93ced60f325461fe0e262b91317b008e6a2d961f13e81af0e4
layer=sha256:8e8df94085bf9af8de500d2042195f1819a4c381b7f3be2a6b920cab65039050
umoci_sha=b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71

# Both public sources are restricted to the same digest-pinned Ubuntu image below.
printf '%s\n' '{"auths":{}}' > "$temporary/auth.json"
cat > "$temporary/policy.json" <<'JSON'
{
  "default": [{"type": "reject"}],
  "transports": {
    "docker": {
      "mirror.gcr.io/library/ubuntu": [{"type": "insecureAcceptAnything"}],
      "docker.io/library/ubuntu": [{"type": "insecureAcceptAnything"}]
    }
  }
}
JSON
copy_base() {
  timeout 150s skopeo --policy "$temporary/policy.json" copy \
    --src-authfile "$temporary/auth.json" --format oci --retry-times 2 \
    "docker://$1@$upstream" "oci:$2:base" >&2
}
if copy_base "$mirror" "$temporary/mirror-base"; then
  mv -T -- "$temporary/mirror-base" "$payload/base"
else
  printf '%s\n' 'Pinned Ubuntu mirror download failed. Retrying from Docker Hub.' >&2
  copy_base "$repository" "$payload/base"
fi

curl --fail --silent --show-error --location --retry 2 --max-time 90 \
  --proto '=https' --proto-redir '=https' --max-filesize 10000000 \
  --output "$payload/umoci" https://github.com/opencontainers/umoci/releases/download/v0.6.0/umoci.linux.amd64
chmod 0555 "$payload/umoci"
/usr/bin/python3 -I -B "$recipe/../packages/runner/host/oci_layout.py" \
  "$payload" "$upstream" "$config" "$layer" "$umoci_sha" > "$temporary/receipt.json"

mv -T --no-clobber -- "$payload" "$destination"
test ! -e "$payload"
cat -- "$temporary/receipt.json"
