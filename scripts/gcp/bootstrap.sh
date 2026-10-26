#!/usr/bin/env bash
# Explicit operator action only. No credentials, keys, deployment, or public access.
set -euo pipefail
umask 077

project='' project_number='' billing_account='' apply=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|--project-number|--billing-account)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --project) project=$2 ;;
        --project-number) project_number=$2 ;;
        --billing-account) billing_account=$2 ;;
      esac
      shift 2 ;;
    --apply) apply=true; shift ;;
    *) echo 'Usage: bootstrap.sh --project ID --project-number NUMBER --billing-account ID [--apply]' >&2; exit 2 ;;
  esac
done
fail() { echo "$*" >&2; exit 1; }
[[ "$project" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail 'Invalid project ID.'
[[ "$project_number" =~ ^[0-9]+$ ]] || fail 'Explicit project number is required.'
[[ "$billing_account" =~ ^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$ ]] || fail 'Invalid billing account ID.'

region=asia-northeast1
repository=mfmf
pool=mfmf-github
provider=github-main
runtime="mfmf-runtime@$project.iam.gserviceaccount.com"
deployer="mfmf-deploy@$project.iam.gserviceaccount.com"
budget_name="mfmf-$project-monthly"
# Numeric IDs prevent repository/owner name reuse from acquiring this trust.
script_dir=$(cd "$(dirname "$0")" && pwd)
source "$script_dir/wif-policy.sh"
condition=$MFMF_WIF_LEGACY_CONDITION
mapping=$MFMF_WIF_MAPPING
principal="principalSet://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/$pool/attribute.repository_id/1271210275"
cat <<PLAN
Project: $project ($project_number); region: $region
Budget: JPY 3000/month for this project, alerts at 50% / 90% / 100% (not a spending cap)
Resources: Docker repository $repository; service accounts mfmf-runtime / mfmf-deploy
Trust: numeric GitHub repository + owner IDs, main, deploy-cloud-run.yml, push/manual only
Runtime: no project roles and no Secret Manager grants
Deployment: repository writer + actAs on runtime only; service-specific Run grant comes later
PLAN
if ! "$apply"; then
  echo 'Plan only; no Google Cloud calls. Add --apply to provision.'
  exit 0
fi
command -v gcloud >/dev/null
command -v jq >/dev/null
# Always pass --project; never alter the operator's active gcloud configuration.
gc() { gcloud "$@" --project="$project" --quiet; }
actual=$(gc projects describe "$project" --format=json)
jq -e --arg number "$project_number" '.projectNumber == $number and .lifecycleState == "ACTIVE"' <<< "$actual" >/dev/null || fail 'Project number/state mismatch.'
linked=$(gc billing projects describe "$project" --format=json)
jq -e --arg account "billingAccounts/$billing_account" '.billingEnabled == true and .billingAccountName == $account' <<< "$linked" >/dev/null || fail 'Project is not linked to the expected active billing account.'
account=$(gc billing accounts describe "$billing_account" --format=json)
jq -e '.open == true' <<< "$account" >/dev/null || fail 'Billing account is closed.'

gc services enable run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com sts.googleapis.com secretmanager.googleapis.com billingbudgets.googleapis.com cloudresourcemanager.googleapis.com >/dev/null

# Create the cost alert before resources. Explicit JPY fails if the billing currency differs.
budgets=$(gc billing budgets list --billing-account="$billing_account" --format=json)
budget=$(jq --arg name "$budget_name" '[.[] | select(.displayName == $name)]' <<< "$budgets")
count=$(jq length <<< "$budget")
if [[ "$count" == 0 ]]; then
  gc billing budgets create --billing-account="$billing_account" --display-name="$budget_name" \
    --budget-amount=3000JPY --calendar-period=month --filter-projects="projects/$project_number" \
    --credit-types-treatment=exclude-all-credits \
    --threshold-rule=percent=0.5,basis=current-spend \
    --threshold-rule=percent=0.9,basis=current-spend \
    --threshold-rule=percent=1,basis=current-spend >/dev/null
elif [[ "$count" == 1 ]]; then
  jq -e --arg project "projects/$project_number" '
    .[0] | .amount.specifiedAmount.currencyCode == "JPY" and
    (.amount.specifiedAmount.units | tostring) == "3000" and
    (.amount.specifiedAmount.nanos // 0) == 0 and
    .budgetFilter.calendarPeriod == "MONTH" and .budgetFilter.projects == [$project] and
    ((.budgetFilter.services // []) | length) == 0 and
    ((.budgetFilter.labels // {}) | length) == 0 and
    ((.budgetFilter.resourceAncestors // []) | length) == 0 and
    ((.budgetFilter.subaccounts // []) | length) == 0 and
    .budgetFilter.creditTypesTreatment == "EXCLUDE_ALL_CREDITS" and
    ((.thresholdRules | map(.thresholdPercent) | sort) == [0.5, 0.9, 1]) and
    all(.thresholdRules[]; (.spendBasis // "CURRENT_SPEND") == "CURRENT_SPEND") and
    (.allUpdatesRule.disableDefaultIamRecipients // false) == false
  ' <<< "$budget" >/dev/null || fail 'Existing budget differs; inspect it manually. No budget was overwritten.'
else
  fail 'Multiple matching budgets; resolve manually before proceeding.'
fi

repos=$(gc artifacts repositories list --location="$region" --format=json)
repo=$(jq --arg suffix "/repositories/$repository" '[.[] | select(.name | endswith($suffix))]' <<< "$repos")
if [[ $(jq length <<< "$repo") == 0 ]]; then
  gc artifacts repositories create "$repository" --location="$region" \
    --repository-format=docker --description='MFMF Cloud Run images' >/dev/null
else
  jq -e 'length == 1 and .[0].format == "DOCKER" and (.[0].mode // "STANDARD_REPOSITORY") == "STANDARD_REPOSITORY"' <<< "$repo" >/dev/null || fail 'Existing Artifact Registry repository has an unexpected format/mode.'
fi
repo_policy=$(gc artifacts repositories get-iam-policy "$repository" --location="$region" --format=json)
jq -e 'all(.bindings[]?.members[]?; . != "allUsers" and . != "allAuthenticatedUsers")' <<< "$repo_policy" >/dev/null || fail 'Repository has public IAM access; inspect manually.'

accounts=$(gc iam service-accounts list --format=json)
for identity in mfmf-runtime mfmf-deploy; do
  email="$identity@$project.iam.gserviceaccount.com"
  existing=$(jq --arg email "$email" '[.[] | select(.email == $email)]' <<< "$accounts")
  if [[ $(jq length <<< "$existing") == 0 ]]; then
    gc iam service-accounts create "$identity" --display-name="$identity" >/dev/null
  else
    jq -e 'length == 1 and (.[0].disabled // false) == false' <<< "$existing" >/dev/null || fail 'Existing service account is disabled or ambiguous.'
  fi
  keys=$(gc iam service-accounts keys list --iam-account="$email" --managed-by=user --format=json)
  [[ $(jq length <<< "$keys") == 0 ]] || fail 'Service account has user-managed keys; inspect manually. No keys were read or removed.'
done
# Existing broad grants must not silently undermine the resource-scoped design.
project_policy=$(gc projects get-iam-policy "$project" --format=json)
jq -e --arg runtime "serviceAccount:$runtime" --arg deployer "serviceAccount:$deployer" \
  'all(.bindings[]?.members[]?; . != $runtime and . != $deployer)' <<< "$project_policy" >/dev/null || fail 'MFMF service account already has project-level roles; inspect manually.'

pools=$(gc iam workload-identity-pools list --location=global --format=json)
existing_pool=$(jq --arg suffix "/workloadIdentityPools/$pool" '[.[] | select(.name | endswith($suffix))]' <<< "$pools")
if [[ $(jq length <<< "$existing_pool") == 0 ]]; then
  gc iam workload-identity-pools create "$pool" --location=global --display-name='MFMF GitHub' >/dev/null
else
  jq -e 'length == 1 and .[0].state == "ACTIVE" and (.[0].disabled // false) == false' <<< "$existing_pool" >/dev/null || fail 'Existing identity pool is inactive.'
fi
providers=$(gc iam workload-identity-pools providers list --location=global --workload-identity-pool="$pool" --format=json)
# A second provider could map an untrusted claim to the same repository principalSet.
jq -e --arg suffix "/providers/$provider" 'all(.[]; .name | endswith($suffix))' <<< "$providers" >/dev/null || fail 'Identity pool has another provider; refusing shared trust.'
if [[ $(jq length <<< "$providers") == 0 ]]; then
  gc iam workload-identity-pools providers create-oidc "$provider" --location=global \
    --workload-identity-pool="$pool" --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="$mapping" --attribute-condition="$condition" >/dev/null
else
  # An operator may already have enabled the separately reviewed production-push
  # condition. Recognize it without changing it; new bootstraps still use legacy trust.
  mfmf_validate_wif_providers "projects/$project_number/locations/global/workloadIdentityPools/$pool/providers/$provider" \
    <<< "$providers" || fail 'Existing WIF provider differs; no trust policy was overwritten.'
fi

# Do not silently coexist with a previously broad impersonation policy.
for email in "$runtime" "$deployer"; do
  policy=$(gc iam service-accounts get-iam-policy "$email" --format=json)
  if [[ "$email" == "$runtime" ]]; then role=roles/iam.serviceAccountUser; member="serviceAccount:$deployer"
  else role=roles/iam.workloadIdentityUser; member="$principal"; fi
  jq -e --arg role "$role" --arg member "$member" \
    'all(.bindings[]?; .role == $role and .condition == null and all(.members[]; . == $member))' <<< "$policy" >/dev/null || fail 'Existing service-account impersonation policy differs; inspect manually.'
done
gc artifacts repositories add-iam-policy-binding "$repository" --location="$region" \
  --member="serviceAccount:$deployer" --role=roles/artifactregistry.writer >/dev/null
gc iam service-accounts add-iam-policy-binding "$runtime" \
  --member="serviceAccount:$deployer" --role=roles/iam.serviceAccountUser >/dev/null
gc iam service-accounts add-iam-policy-binding "$deployer" \
  --member="$principal" --role=roles/iam.workloadIdentityUser >/dev/null

cat <<RESULT
Bootstrap completed. No Cloud Run service was deployed or made public.
Artifact Registry: $region-docker.pkg.dev/$project/$repository
Runtime identity: $runtime
Deploy identity: $deployer
WIF provider: projects/$project_number/locations/global/workloadIdentityPools/$pool/providers/$provider
After the operator creates the private candidate service, use grant-deploy-access.sh for service-scoped deploy permissions.
RESULT
