#!/usr/bin/env bash
# Explicit operator action: change only the existing provider's attribute condition.
set -euo pipefail
umask 077
project='' project_number='' apply=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--project-number)
      [[ $# -ge 2 ]] || { echo 'Missing required argument.' >&2; exit 2; }
      if [[ "$1" == --project ]]; then project=$2; else project_number=$2; fi
      shift 2 ;;
    --apply) [[ "$apply" == false ]] || exit 2; apply=true; shift ;;
    *) echo 'Usage: enable-production-wif.sh --project ID --project-number NUMBER [--apply]' >&2; exit 2 ;;
  esac
done
fail() { echo "$*" >&2; exit 1; }
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail 'Invalid project ID.'
[[ "$project_number" =~ ^[0-9]+$ ]] || fail 'Explicit project number is required.'
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/wif-policy.sh"
pool=mfmf-github
provider=github-main
pool_name="projects/$project_number/locations/global/workloadIdentityPools/$pool"
provider_name="$pool_name/providers/$provider"
cat <<PLAN
Target: $provider_name in project $project
Keep numeric repository/owner IDs and main ref unchanged.
Keep deploy-cloud-run.yml on main: push / workflow_dispatch.
Add deploy-production.yml on main: push only.
Only the provider attribute condition may change; no IAM, service, secret, or other resource changes.
PLAN
if ! "$apply"; then
  echo 'Plan only; no Google Cloud calls. Add --apply after reviewing the target and workflow.'
  exit 0
fi
command -v gcloud >/dev/null
command -v jq >/dev/null
# Suppress CLI output, including error bodies; never persist credential/config output.
gc() { gcloud "$@" --project="$project" --quiet 2>/dev/null; }
actual=$(gc projects describe "$project" --format=json) || fail 'Project metadata could not be read; no update attempted.'
jq -e --arg number "$project_number" '.projectNumber == $number and .lifecycleState == "ACTIVE"' <<< "$actual" >/dev/null 2>/dev/null || fail 'Project number/state mismatch; no update attempted.'
pools=$(gc iam workload-identity-pools list --location=global --format=json) || fail 'Pool metadata could not be read; no update attempted.'
jq -e --arg name "$pool_name" '
  [.[] | select(.name == $name)] | length == 1 and
  .[0].state == "ACTIVE" and (.[0].disabled // false) == false
' <<< "$pools" >/dev/null 2>/dev/null || fail 'Expected identity pool is missing or inactive; no update attempted.'
read_providers() {
  gc iam workload-identity-pools providers list --location=global --workload-identity-pool="$pool" --format=json
}
before=$(read_providers) || fail 'Provider metadata could not be read; no update attempted.'
mfmf_validate_wif_providers "$provider_name" <<< "$before" || fail 'Existing WIF provider differs from the reviewed policies; no update attempted.'
condition=$(jq -r '.[0].attributeCondition' <<< "$before" 2>/dev/null) || fail 'Provider condition could not be read; no update attempted.'
if [[ "$condition" == "$MFMF_WIF_PRODUCTION_CONDITION" ]]; then
  echo 'The exact production-push policy is already configured; no update sent.'
  exit 0
fi
# A second read detects intervening edits. The CLI exposes no compare-and-swap flag;
# the operator must prevent concurrent provider edits until verification finishes.
latest=$(read_providers) || fail 'Provider recheck failed; no update attempted.'
[[ "$(jq -S -c . <<< "$latest" 2>/dev/null)" == "$(jq -S -c . <<< "$before" 2>/dev/null)" ]] || fail 'Provider changed before update; no update attempted.'
if ! gc iam workload-identity-pools providers update-oidc "$provider" \
  --location=global --workload-identity-pool="$pool" \
  --attribute-condition="$MFMF_WIF_PRODUCTION_CONDITION" >/dev/null; then
  fail 'Provider update was attempted but its result is unknown. Inspect metadata before any retry; no rollback attempted.'
fi
after=$(read_providers) || fail 'Provider update was attempted but verification failed. Inspect metadata before any retry; no rollback attempted.'
mfmf_validate_wif_providers "$provider_name" <<< "$after" || fail 'Provider verification differs after update. Inspect metadata; no retry or rollback attempted.'
jq -e --arg expected "$MFMF_WIF_PRODUCTION_CONDITION" '.[0].attributeCondition == $expected' <<< "$after" >/dev/null 2>/dev/null || fail 'Provider condition did not verify after update; no retry or rollback attempted.'
# Updating only attributeCondition must preserve the rest of the provider metadata.
[[ "$(jq -S -c '.[0] | del(.attributeCondition)' <<< "$after" 2>/dev/null)" == "$(jq -S -c '.[0] | del(.attributeCondition)' <<< "$before" 2>/dev/null)" ]] || fail 'Other provider metadata changed during update. Inspect metadata; no retry or rollback attempted.'
echo 'Verified: production main push added; existing workflow trust and all other provider metadata preserved.'
