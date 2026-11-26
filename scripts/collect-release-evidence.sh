#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ $# == 1 && "$GITHUB_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
root=$(git rev-parse --show-toplevel)
cd "$root"
commit=$(git rev-parse HEAD)
tree=$(git rev-parse 'HEAD^{tree}')
test "$commit" = "$GITHUB_SHA"
output=$1
mkdir -- "$output"

# Verify run ownership, provenance and every current job before opening its artifacts.
require_run() {
  local key=$1 workflow=$2
  shift 2
  [[ "$key" =~ ^[1-9][0-9]{0,15}$ ]]
  gh api "repos/$GITHUB_REPOSITORY/actions/runs/$key" | jq -e \
    --arg repo "$GITHUB_REPOSITORY" --arg commit "$commit" --arg ref "$GITHUB_REF_NAME" \
    --arg path ".github/workflows/$workflow.yml" '
      .repository.full_name == $repo and .head_repository.full_name == $repo and .head_sha == $commit and .head_branch == $ref and
      .path == $path and (.event == "push" or .event == "workflow_dispatch") and .status == "completed" and .conclusion == "success"
    ' >/dev/null
  gh api "repos/$GITHUB_REPOSITORY/actions/runs/$key/jobs?filter=latest&per_page=100" > "$output/jobs-$key.json"
  jq -e --args '
    .jobs as $jobs | .total_count == ($jobs | length) and
    all($jobs[]; .status == "completed" and .conclusion == "success") and
    all($ARGS.positional[]; . as $name | ($jobs | map(select(.name == $name)) | length) == 1)
  ' "$@" < "$output/jobs-$key.json" >/dev/null
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/actions/runs/$key/artifacts?per_page=100" > "$output/artifacts-$key.json"
}

require_run "$VERIFICATION_RUN" verification deterministic portal scanners
require_run "$NATIVE_RUN" native-runner reference-repeatability 'kvm-evidence (regression)' 'kvm-evidence (rule-samples)' \
  'kvm-evidence (standard-build)' 'kvm-evidence (standard-build-missing-cache)' 'kvm-evidence (standard-oci)' \
  'kvm-evidence (protected-release)' 'kvm-evidence (protected-release-npm)' 'kvm-evidence (protected-release-drift)' \
  'kvm-evidence (protected-release-faults)' 'kvm-evidence (protected-release-operations)' 'kvm-evidence (protected-release-restore)' \
  'kvm-evidence (protected-release-restore-authorization)' 'kvm-evidence (protected-release-linked-health)' \
  'kvm-evidence (reference-development-1, true)' 'kvm-evidence (reference-development-2, true)' \
  'kvm-evidence (reference-development-3, true)' 'kvm-evidence (reference-code-rule)' 'kvm-evidence (reference-version-restore)'
require_run "$SOURCE_RUN" source-release source-release

download() {
  local run=$1 job=$2 artifact=$3
  shift 3
  local id archive_file file
  # A failed attempt can publish the same artifact name. Select the copy created by the successful job.
  id=$(jq -er --arg job "$job" --arg name "$artifact" --arg head "$commit" --slurpfile jobs "$output/jobs-$run.json" '
    ($jobs[0].jobs[] | select(.name == $job)) as $owner |
    map(.artifacts) | add |
    map(select(.name == $name and .expired == false and .workflow_run.head_sha == $head and
      .created_at >= $owner.started_at and .created_at <= $owner.completed_at)) |
    if length == 1 then .[0].id else error("no unique artifact from the successful job") end
  ' "$output/artifacts-$run.json")
  [[ "$id" =~ ^[1-9][0-9]{0,15}$ ]]
  archive_file="$output/$artifact.zip"
  if ! gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > "$archive_file" 2>/dev/null; then
    printf 'Could not load release artifact %s from workflow %s.\n' "$artifact" "$run" >&2
    exit 1
  fi
  mkdir -- "$output/$artifact"
  for file in "$@"; do
    unzip -p "$archive_file" "$file" > "$output/$artifact/$file"
  done
}

version=$(jq -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' package.json)
archive="itervane-$version.tar.gz"
download "$VERIFICATION_RUN" deterministic verification-regression verification-regression.json
download "$VERIFICATION_RUN" portal reference-installation-upgrade reference-upgrade.json
download "$NATIVE_RUN" reference-repeatability native-reference-repeatability summary.json
for index in 1 2 3; do
  download "$NATIVE_RUN" "kvm-evidence (reference-development-$index, true)" "kvm-reference-development-$index-evidence" \
    runner-reference-development.json
done
download "$NATIVE_RUN" 'kvm-evidence (reference-version-restore)' kvm-reference-version-restore-evidence runner-reference-version-restore.json
download "$NATIVE_RUN" 'kvm-evidence (reference-code-rule)' kvm-reference-code-rule-evidence runner-reference-code-rule.json
download "$NATIVE_RUN" 'kvm-evidence (protected-release-operations)' kvm-protected-release-operations-evidence \
  runner-protected-release.json runner-oci-artifact.json
download "$NATIVE_RUN" 'kvm-evidence (protected-release-faults)' kvm-protected-release-faults-evidence runner-protected-release.json
download "$SOURCE_RUN" source-release source-release-assets "$archive" dependency-licenses.json release-manifest.json SHA256SUMS
download "$SOURCE_RUN" source-release source-release-installation source-install.json

assets="$output/source-release-assets"
for file in "$archive" dependency-licenses.json release-manifest.json; do
  [[ -f "$assets/$file" && ! -L "$assets/$file" ]]
  expected_digest=$(awk -v name="$file" '$2 == name && length($1) == 64 && $1 ~ /^[a-f0-9]+$/ {print $1}' "$assets/SHA256SUMS")
  actual_digest=$(sha256sum < "$assets/$file" | cut -d' ' -f1)
  test "$expected_digest" = "$actual_digest"
done
archive_digest=$(sha256sum < "$assets/$archive" | cut -d' ' -f1)
licenses_digest=$(sha256sum < "$assets/dependency-licenses.json" | cut -d' ' -f1)
lockfile_digest=$(git show "${commit}:pnpm-lock.yaml" | sha256sum | cut -d' ' -f1)

reports=()
for index in 1 2 3; do
  reports+=("$output/kvm-reference-development-$index-evidence/runner-reference-development.json")
done
jq -s -e --arg tree "$tree" --arg workflow "$NATIVE_RUN" -f fixtures/runner/reference-evidence.jq \
  "${reports[@]}" > "$output/repeatability.json"
diff -q "$output/repeatability.json" "$output/native-reference-repeatability/summary.json"

restore="$output/kvm-reference-version-restore-evidence/runner-reference-version-restore.json"
jq -e --arg tree "$tree" -f fixtures/runner/reference-version-restore.jq "$restore" >/dev/null
operations="$output/kvm-protected-release-operations-evidence"
jq -n -e --arg commit "$commit" --arg tree "$tree" --arg release "v$version" --arg repo "$GITHUB_REPOSITORY" \
  --arg verification "$VERIFICATION_RUN" --arg native "$NATIVE_RUN" --arg source "$SOURCE_RUN" \
  --arg archive "$archive_digest" --arg licenses "$licenses_digest" --arg lockfile "$lockfile_digest" \
  --slurpfile manifest "$assets/release-manifest.json" --slurpfile packages "$assets/dependency-licenses.json" \
  --slurpfile installed "$output/source-release-installation/source-install.json" \
  --slurpfile regression "$output/verification-regression/verification-regression.json" \
  --slurpfile upgrade "$output/reference-installation-upgrade/reference-upgrade.json" \
  --slurpfile repeated "$output/repeatability.json" --slurpfile development "${reports[0]}" \
  --slurpfile code "$output/kvm-reference-code-rule-evidence/runner-reference-code-rule.json" \
  --slurpfile restore "$restore" --slurpfile backup "$operations/runner-protected-release.json" \
  --slurpfile stored "$operations/runner-oci-artifact.json" \
  --slurpfile fault "$output/kvm-protected-release-faults-evidence/runner-protected-release.json" \
  -f scripts/collect-release-evidence.jq > "$output/release-acceptance.pending"
mv -- "$output/release-acceptance.pending" "$output/release-acceptance.json"
