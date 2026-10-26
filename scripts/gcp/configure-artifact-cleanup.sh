#!/usr/bin/env bash
# Only the dedicated bootstrap-created repository. Never delete images directly.
set -euo pipefail
umask 077
project='' project_number='' mode=plan
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--project-number)
      [[ $# -ge 2 ]] || exit 2
      if [[ "$1" == --project ]]; then project=$2; else project_number=$2; fi
      shift 2 ;;
    --dry-run|--apply)
      [[ "$mode" == plan ]] || { echo 'Choose one mode.' >&2; exit 2; }
      mode=${1#--}; shift ;;
    *) echo 'Usage: configure-artifact-cleanup.sh --project ID --project-number NUMBER [--dry-run | --apply]' >&2; exit 2 ;;
  esac
done
fail() { echo "$*" >&2; exit 1; }
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail 'Invalid project ID.'
[[ "$project_number" =~ ^[0-9]+$ ]] || fail 'Explicit project number is required.'
region=asia-northeast1
repository=mfmf
script_dir=$(cd "$(dirname "$0")" && pwd)
echo "Target: projects/$project/locations/$region/repositories/$repository ($project_number)"
echo 'Delete versions older than 14 days, except the five most recent versions of each package.'
echo 'This is retention, not a hard storage/spending cap; recent uploads can exceed five versions.'
if [[ "$mode" == plan ]]; then
  cat "$script_dir/artifact-cleanup.json"
  echo 'Plan only; no Google Cloud calls. --dry-run installs simulation; --apply enables deletion after simulation is configured.'
  exit 0
fi
command -v gcloud >/dev/null
command -v jq >/dev/null
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
cp "$script_dir/artifact-cleanup.json" "$work_dir/policy.json"
# Validate the exact reviewed policy snapshot before asking the CLI to apply it.
jq -e '. == [
  {"name":"mfmf-delete-after-14d", "action":{"type":"Delete"}, "condition":{"tagState":"any", "olderThan":"14d"}},
  {"name":"mfmf-keep-last-5", "action":{"type":"Keep"}, "mostRecentVersions":{"keepCount":5}}
]' "$work_dir/policy.json" >/dev/null || fail 'Cleanup policy changed; review script and policy together.'
gc() { gcloud "$@" --project="$project" --quiet; }
actual=$(gc projects describe "$project" --format=json)
jq -e --arg number "$project_number" '.projectNumber == $number and .lifecycleState == "ACTIVE"' <<< "$actual" >/dev/null || fail 'Project number/state mismatch.'
repo=$(gc artifacts repositories describe "$repository" --location="$region" --format=json)
jq -e --arg name "projects/$project/locations/$region/repositories/$repository" \
  --arg number_name "projects/$project_number/locations/$region/repositories/$repository" '
  (.name == $name or .name == $number_name) and .format == "DOCKER" and
  (.mode // "STANDARD_REPOSITORY") == "STANDARD_REPOSITORY" and
  .description == "MFMF Cloud Run images"
' <<< "$repo" >/dev/null || fail 'Not the dedicated bootstrap-created MFMF Docker repository.'
existing=$(jq '.cleanupPolicies // {} | with_entries(.value |= del(.id))' <<< "$repo")
expected='{"mfmf-delete-after-14d":{"action":"DELETE","condition":{"tagState":"ANY","olderThan":"1209600s"}},"mfmf-keep-last-5":{"action":"KEEP","mostRecentVersions":{"keepCount":5}}}'
if [[ $(jq length <<< "$existing") == 0 ]]; then
  [[ "$mode" == dry-run ]] || fail 'Install --dry-run first and inspect it before enabling deletion.'
else
  jq -e --argjson expected "$expected" '. == $expected' <<< "$existing" >/dev/null || fail 'Existing cleanup policies differ; refusing to replace other retention rules.'
fi
if [[ "$mode" == dry-run ]]; then dry_run_flag=--dry-run; else dry_run_flag=--no-dry-run; fi
gc artifacts repositories set-cleanup-policies "$repository" --location="$region" \
  --policy="$work_dir/policy.json" "$dry_run_flag" >/dev/null
if [[ "$mode" == dry-run ]]; then
  echo 'Simulation configured; no versions are deleted. Review the scheduled dry-run results before --apply.'
else
  echo 'Deletion policy enabled for the dedicated MFMF repository. Cleanup runs asynchronously.'
fi
