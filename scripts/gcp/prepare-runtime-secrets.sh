#!/usr/bin/env bash
# Create containers and resource-scoped grants only. Never read/write secret values.
set -euo pipefail
project='' apply=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      [[ $# -ge 2 ]] || exit 2
      project=$2; shift 2 ;;
    --apply) apply=true; shift ;;
    *) echo 'Usage: prepare-runtime-secrets.sh --project ID [--apply]' >&2; exit 2 ;;
  esac
done
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || exit 2
runtime="mfmf-runtime@$project.iam.gserviceaccount.com"
deployer="mfmf-deploy@$project.iam.gserviceaccount.com"
secrets=(mfmf-token-enc-key mfmf-google-client-id mfmf-google-client-secret mfmf-sentry-dsn)
printf 'Secret containers in %s: %s\n' "$project" "${secrets[*]}"
echo 'Grant only versionAdder to mfmf-deploy and secretAccessor to mfmf-runtime on these containers.'
if ! "$apply"; then echo 'Plan only; no Google Cloud calls. Add --apply to prepare.'; exit 0; fi
command -v gcloud >/dev/null
command -v jq >/dev/null
gc() { gcloud "$@" --project="$project" --quiet; }
accounts=$(gc iam service-accounts list --format=json)
for email in "$runtime" "$deployer"; do
  jq -e --arg email "$email" '[.[] | select(.email == $email and (.disabled // false) == false)] | length == 1' <<< "$accounts" >/dev/null || { echo 'Expected active service account missing; complete bootstrap first.' >&2; exit 1; }
done
existing=$(gc secrets list --format=json)
for secret in "${secrets[@]}"; do
  matches=$(jq --arg suffix "/secrets/$secret" '[.[] | select(.name | endswith($suffix))]' <<< "$existing")
  if [[ $(jq length <<< "$matches") == 0 ]]; then
    gc secrets create "$secret" --replication-policy=user-managed --locations=asia-northeast1 --labels=app=mfmf >/dev/null
  else
    jq -e 'length == 1 and (.[0].replication.userManaged.replicas | map(.location)) == ["asia-northeast1"]' <<< "$matches" >/dev/null || { echo 'Existing secret uses another replication policy; inspect manually.' >&2; exit 1; }
  fi
  policy=$(gc secrets get-iam-policy "$secret" --format=json)
  jq -e 'all(.bindings[]?.members[]?; . != "allUsers" and . != "allAuthenticatedUsers")' <<< "$policy" >/dev/null || { echo 'Existing secret has public IAM access; inspect manually.' >&2; exit 1; }
  gc secrets add-iam-policy-binding "$secret" --member="serviceAccount:$deployer" \
    --role=roles/secretmanager.secretVersionAdder --condition=None >/dev/null
  gc secrets add-iam-policy-binding "$secret" --member="serviceAccount:$runtime" \
    --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
done
echo 'Secret containers and scoped grants prepared. No secret values or versions were read or created.'
