#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# -eq 1 && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]
binary=$(realpath -- "$1")
reference=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
fingerprint=$(node -e 'console.log(require(process.argv[1]).traefik.binarySha256)' "$reference/../versions.json")
printf '%s  %s\n' "$fingerprint" "$binary" | sha256sum --check --strict >/dev/null
project=itervane-network-$(openssl rand -hex 5)
directory=$(mktemp -d /tmp/itervane-ingress-network.XXXXXX)
app=$project-app
network=$project-private
image=docker.io/library/node:24-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
phase=setup
curl() { command curl --noproxy '*' "$@"; }
compose=(docker compose --project-name "$project" --env-file "$directory/install.env" --file "$reference/compose.yml" --file "$directory/override.yml")
cleanup() {
  status=$?
  trap - EXIT
  if ((status != 0)); then
    printf 'Test stopped during %s\n' "$phase" >&2
  fi
  if [[ "$(docker inspect --format '{{ index .Config.Labels "io.itervane.network-test" }}' "$app" 2>/dev/null || true)" == "$project" ]]; then
    docker rm --force "$app" >/dev/null
  fi
  if [[ -f "$directory/install.env" && -f "$directory/override.yml" ]]; then
    "${compose[@]}" down --timeout 3 >/dev/null 2>&1 || true
  fi
  if [[ "$(docker network inspect --format '{{ index .Labels "io.itervane.network-test" }}' "$network" 2>/dev/null || true)" == "$project" ]]; then
    docker network rm "$network" >/dev/null
  fi
  rm -r -- "$directory"
  exit "$status"
}
trap cleanup EXIT
read -r tls_port admin_port < <(python3 - <<'PYTHON'
import socket
with socket.socket() as tls, socket.socket() as admin:
    tls.bind(("127.0.0.1", 0))
    admin.bind(("127.0.0.1", 0))
    print(tls.getsockname()[1], admin.getsockname()[1])
PYTHON
)
mkdir "$directory/dynamic" "$directory/tls"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=itervane-network-test \
  -addext subjectAltName=IP:127.0.0.1 -keyout "$directory/tls/key.pem" -out "$directory/tls/certificate.pem" 2>/dev/null
sed -e 's/demo.example.invalid/127.0.0.1/g' -e "s/demo-container/$app/g" -e '/^tls:/,$d' \
  "$reference/traefik.example.yml" > "$directory/dynamic/routes.yml"
cat >> "$directory/dynamic/routes.yml" <<'YAML'
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/tls/certificate.pem
        keyFile: /etc/traefik/tls/key.pem
YAML
# The outer directory remains private. The mounted test assets must be readable by the dropped-capability container.
chmod 0755 "$directory/dynamic" "$directory/tls"
chmod 0444 "$directory/dynamic/routes.yml" "$directory/tls/certificate.pem" "$directory/tls/key.pem"
install -m 0555 -- "$binary" "$directory/traefik"
: > "$directory/empty.env"
cat > "$directory/install.env" <<ENV
ITERVANE_TRAEFIK_CONFIG_DIR=$directory/dynamic
ITERVANE_INGRESS_TLS_DIR=$directory/tls
ITERVANE_OAUTH2_CONFIG=$reference/oauth2-proxy.example.cfg
ITERVANE_OAUTH2_SECRETS_FILE=$directory/empty.env
ITERVANE_APPLICATION_NETWORK=$network
ITERVANE_INGRESS_PORT=$tls_port
ITERVANE_INGRESS_MANAGEMENT_PORT=$admin_port
ENV
cat > "$directory/override.yml" <<YAML
services:
  traefik:
    image: $image
    entrypoint: [/probe/traefik]
    volumes:
      - $directory/traefik:/probe/traefik:ro
  management-gateway:
    image: $image
    entrypoint: [/probe/traefik]
    volumes:
      - $directory/traefik:/probe/traefik:ro
  oauth2-proxy:
    image: $image
    entrypoint: [node, -e]
    command:
      - "require('node:http').createServer((req,res) => res.writeHead(req.headers.authorization === 'Bearer local-test-fixture' ? 202 : 401).end()).listen(4180,'0.0.0.0')"
YAML
phase=network
docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
docker network create --internal --label "io.itervane.network-test=$project" "$network" >/dev/null
docker run --detach --pull never --name "$app" --label "io.itervane.network-test=$project" --network "$network" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true "$image" node -e \
  'require("node:http").createServer((req,res) => { const ok=!req.headers.authorization && !req.headers.cookie; res.writeHead(ok?200:400,{"content-type":"application/json"}).end(JSON.stringify({status:"healthy",version:"network-fixture"})) }).listen(3000,"0.0.0.0")' >/dev/null
phase=proxy
"${compose[@]}" config --quiet
"${compose[@]}" up --detach --no-build --pull never >/dev/null
mgmt=http://127.0.0.1:$admin_port/api/http/routers
for attempt in $(seq 40); do
  if curl --max-time 2 --silent --fail "$mgmt" -o /dev/null; then break; fi
  sleep 0.4
done
phase=management-get
code=$(curl --max-time 5 --silent --output /dev/null --write-out '%{http_code}' "$mgmt" || true)
if [[ "$code" != 200 ]]; then printf 'management-get=%s\n' "$code"; exit 1; fi
phase=management-post
code=$(curl --max-time 5 --silent --request POST --output /dev/null --write-out '%{http_code}' "$mgmt" || true)
if [[ "$code" != 404 ]]; then printf 'management-post=%s\n' "$code"; exit 1; fi
tls=https://127.0.0.1:$tls_port/health
phase=anonymous-tls
code=$(curl --cacert "$directory/tls/certificate.pem" --max-time 5 --silent --output /dev/null --write-out '%{http_code}' "$tls" || true)
if [[ "$code" != 401 ]]; then printf 'anonymous-tls=%s\n' "$code"; exit 1; fi
phase=authorized-tls
code=$(curl --cacert "$directory/tls/certificate.pem" --max-time 5 --silent --header 'Authorization: Bearer local-test-fixture' --output /dev/null --write-out '%{http_code}' "$tls" || true)
if [[ "$code" != 200 ]]; then printf 'authorized-tls=%s\n' "$code"; exit 1; fi
phase=isolated-app
test -z "$(docker port "$app")"
auth_id=$("${compose[@]}" ps --quiet oauth2-proxy)
test -z "$(docker port "$auth_id")"
auth_ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$auth_id")
docker exec "$app" node --input-type=module -e '
const authorities = ["http://172.31.92.2:8080/api/http/routers", "http://" + process.argv[1] + ":4180/oauth2/auth"];
for (const authority of authorities) {
  let reachable = true;
  try { const response = await fetch(authority,{signal:AbortSignal.timeout(1500)}); await response.body?.cancel(); }
  catch { reachable = false; }
  if (reachable) process.exit(1);
}
' "$auth_ip"
node --import tsx --input-type=module <<'NODE'
import { report, saveReport } from './packages/verification/src/report.ts';
const result = report('protected-ingress-network', [
  { id: 'loopback-read-only', status: 'passed', detail: 'The host read the real Traefik API over loopback. A write method was rejected.' },
  { id: 'protected-tls', status: 'passed', detail: 'The real proxy served trusted TLS, rejected anonymous access and stripped authorization before forwarding.' },
  { id: 'private-targets', status: 'passed', detail: 'The application and fixture authorization service had no host ports. The application could not reach the private authorization or management endpoints.' },
]);
await saveReport(result);
console.log(JSON.stringify(result));
NODE
