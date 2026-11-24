#!/bin/sh
set -eu

# Only the tracked synthetic input is used while sealing the offline image.
/usr/sbin/runuser -u itervane-scan -- /bin/sh -se <<'CHECK'
sample=$(mktemp -d /tmp/itervane-rule-preflight.XXXXXX)
trap 'rm -r -- "$sample"' EXIT
cd "$sample"
printf '%s\n' 'reply.status(503).json({ state: "unhealthy" }); // nosemgrep' > example.js
printf '%s\n' '{"rules":[{"id":"image-preflight","languages":["javascript"],"message":"Image preflight match.","severity":"WARNING","pattern":"$RESPONSE.status(503).json(...)"}]}' > rule.json
chmod 0400 example.js rule.json
if ! /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$sample" XDG_CACHE_HOME="$sample" \
  /usr/bin/python3 -I -B /usr/local/libexec/itervane-semgrep/entry.py scan \
  --metrics=off --disable-version-check --disable-nosem --no-git-ignore --no-rewrite-rule-ids \
  --strict --max-target-bytes=6400 --timeout=8 --jobs=1 --json --quiet --config rule.json example.js > report.json; then
  head -c 4096 report.json
  exit 1
fi
/usr/bin/python3 -I -B - <<'PYTHON'
import json

with open('report.json', encoding='utf-8') as report:
    result = json.load(report)
if result['errors'] or len(result['results']) != 1 or result['results'][0]['check_id'] != 'image-preflight':
    raise SystemExit('Sealed guest did not scan the synthetic sample')
print('Sealed guest checked the synthetic sample with Semgrep', result['version'])
PYTHON
CHECK
