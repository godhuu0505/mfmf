#!/usr/bin/env bash
# Run only after an operator has created and reviewed the private candidate service.
set -euo pipefail
project='' service='' apply=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--service)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      if [[ "$1" == --project ]]; then project=$2; else service=$2; fi
      shift 2 ;;
    --apply) apply=true; shift ;;
    *) echo 'Usage: grant-deploy-access.sh --project ID --service NAME [--apply]' >&2; exit 2 ;;
  esac
done
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || exit 2
[[ "$service" =~ ^[a-z][a-z0-9-]{0,47}[a-z0-9]$ ]] || exit 2
region=asia-northeast1
runtime="mfmf-runtime@$project.iam.gserviceaccount.com"
deployer="mfmf-deploy@$project.iam.gserviceaccount.com"
echo "Grant roles/run.developer to $deployer on existing $region/$service only."
if ! "$apply"; then echo 'Plan only; add --apply to grant.'; exit 0; fi
command -v gcloud >/dev/null
command -v jq >/dev/null
current=$(gcloud run services describe "$service" --project="$project" --region="$region" --format=json)
jq -e --arg runtime "$runtime" '.spec.template.spec.serviceAccountName == $runtime and (.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] // "false") != "true"' <<< "$current" >/dev/null || { echo 'Unexpected runtime identity or disabled invoker IAM check.' >&2; exit 1; }
policy=$(gcloud run services get-iam-policy "$service" --project="$project" --region="$region" --format=json)
jq -e 'all(.bindings[]?.members[]?; . != "allUsers" and . != "allAuthenticatedUsers")' <<< "$policy" >/dev/null || { echo 'Service is public; inspect before granting deploy access.' >&2; exit 1; }
gcloud run services add-iam-policy-binding "$service" --project="$project" --region="$region" \
  --member="serviceAccount:$deployer" --role=roles/run.developer --quiet >/dev/null
echo 'Service-scoped deployment grant added; public access and existing bindings were not changed.'
