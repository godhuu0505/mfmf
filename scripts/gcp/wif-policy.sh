#!/usr/bin/env bash
# Shared policy constants and validation only. Sourcing this file performs no cloud calls.
MFMF_WIF_SCOPE="assertion.repository_id == '1271210275' && assertion.repository_owner_id == '19723431' && assertion.ref == 'refs/heads/main'"
MFMF_WIF_MANUAL="assertion.workflow_ref == 'godhuu0505/mfmf/.github/workflows/deploy-cloud-run.yml@refs/heads/main' && assertion.event_name in ['push', 'workflow_dispatch']"
MFMF_WIF_LEGACY_CONDITION="$MFMF_WIF_SCOPE && $MFMF_WIF_MANUAL"
MFMF_WIF_PRODUCTION_CONDITION="$MFMF_WIF_SCOPE && (($MFMF_WIF_MANUAL) || (assertion.workflow_ref == 'godhuu0505/mfmf/.github/workflows/deploy-production.yml@refs/heads/main' && assertion.event_name == 'push'))"
MFMF_WIF_MAPPING='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id'

# Input: provider-list JSON on stdin. Both exact reviewed conditions are recognized;
# this does not authorize rewriting any other policy into one of these conditions.
mfmf_validate_wif_providers() {
  local expected_name=$1
  jq -e --arg name "$expected_name" --arg legacy "$MFMF_WIF_LEGACY_CONDITION" \
    --arg production "$MFMF_WIF_PRODUCTION_CONDITION" '
    length == 1 and .[0].name == $name and
    .[0].state == "ACTIVE" and (.[0].disabled // false) == false and
    .[0].oidc.issuerUri == "https://token.actions.githubusercontent.com" and
    ((.[0].oidc.allowedAudiences // []) | length) == 0 and
    (.[0].oidc.jwksJson // "") == "" and
    (.[0].oidc.discoveryUri // "") == "" and
    ((.[0].actorProviders // []) | length) == 0 and
    .[0].attributeMapping == {"google.subject":"assertion.sub", "attribute.repository_id":"assertion.repository_id"} and
    (.[0].attributeCondition == $legacy or .[0].attributeCondition == $production)
  ' >/dev/null 2>/dev/null
}
