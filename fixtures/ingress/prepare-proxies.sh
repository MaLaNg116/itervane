#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 1 ]]
work=$1
versions="$(dirname -- "${BASH_SOURCE[0]}")/versions.json"
mkdir -m 0700 -- "$work"
traefik="$(jq -er '.traefik.version' "$versions")"
oauth="$(jq -er '.oauth2Proxy.version' "$versions")"
[[ "$traefik" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$oauth" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
edge_file="traefik_${traefik}_linux_amd64.tar.gz"
auth_dir="oauth2-proxy-${oauth}.linux-amd64"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 180 \
  "https://github.com/traefik/traefik/releases/download/$traefik/$edge_file" --output "$work/traefik.tgz"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 180 \
  "https://github.com/oauth2-proxy/oauth2-proxy/releases/download/$oauth/$auth_dir.tar.gz" --output "$work/oauth.tgz"
printf '%s  %s\n' "$(jq -er '.traefik.archiveSha256' "$versions")" "$work/traefik.tgz" | sha256sum --check --strict
tar -xOzf "$work/traefik.tgz" traefik > "$work/traefik"
tar -xOzf "$work/oauth.tgz" "$auth_dir/oauth2-proxy" > "$work/oauth2-proxy"
for name in traefik oauth2-proxy; do
  case "$name" in
    traefik) digest="$(jq -er '.traefik.binarySha256' "$versions")" ;;
    oauth2-proxy) digest="$(jq -er '.oauth2Proxy.binarySha256' "$versions")" ;;
  esac
  printf '%s  %s\n' "$digest" "$work/$name" | sha256sum --check --strict
  chmod 0500 -- "$work/$name"
done
