# GCS storage adapter and operator checks

The adapter is server-only. It does not authorize an application user: callers must establish the
operation-specific authorization, reservation state and irreversible deletion ledger before calling it.
Read callers must compare the final object's provider metadata and generation with the expected binding;
neither a database path nor an untrusted finalize RPC is an attestation. `_incoming/` objects are never
issued read URLs. Existing imported files may retain their MIME and filename; new uploads use image
validation. This change does not switch the application from Supabase Storage.

## Fixed resources and IAM

- Project `mfmf-499612` (`92772745697`), region `asia-northeast1`.
- Buckets `mfmf-499612-photos` and `mfmf-499612-avatars`: Standard, uniform bucket-level access,
  public access prevention, Object Versioning off, seven-day soft delete.
- Lifecycle Delete applies only to `_incoming/` at age one day. It never targets final paths. Lifecycle
  is asynchronous and does not replace reservation expiry, deletion ledgers or generation-specific cleanup.
- Runtime `mfmf-runtime@mfmf-499612.iam.gserviceaccount.com` gets the custom object role
  `storage.objects.get/create/delete` on these two buckets only, and a custom self role with
  `iam.serviceAccounts.signBlob` only. No list, restore, bucket administration or IAM permissions are added.
- Runtime uses the Cloud Run metadata server's short-lived access token. No SA key, HMAC key,
  `GOOGLE_APPLICATION_CREDENTIALS`, credentials file or new secret environment value is needed.

Ensure Cloud Storage, IAM and Service Account Credentials APIs are enabled through the operator's
existing infrastructure process. The bootstrap does not enable APIs or broaden the CI WIF policy.

## Operator bootstrap

Use Node 22 and an already authenticated operator `gcloud` session. The command obtains one short-lived
operator access token into process memory. It does not print the token or API response body.

```bash
node scripts/gcp/bootstrap-storage.mjs --origin https://mfmf-1223.vercel.app
node scripts/gcp/bootstrap-storage.mjs --origin https://mfmf-1223.vercel.app --apply
```

Confirm the Vercel URL is still the intended production origin before applying. The fixed Cloud Run
origin is always included; Vercel origins are explicit operator input. No wildcard, localhost, preview
wildcard, path or credential-bearing origin is accepted. Browser methods are GET/HEAD/PUT and required
signed headers are allowed. OPTIONS is handled by the service, not added as a configured method.

The default is a read-only plan (IAM `getIamPolicy` uses POST but does not modify policy). Apply first
checks all existing resources, then creates missing fixed resources and adds only the expected binding.
Existing divergent configuration or permissions stop the run; they are not silently repaired. IAM writes
preserve other members and use etags. A partial failure may leave created resources: inspect them before
retrying. The script does not blindly retry conflicts or delete resources to recover.
Failed API calls report only the fixed resource category, HTTP method and status. Newly created custom
roles can take time to propagate; a failed binding does not justify recreating buckets or widening IAM.
Read and validate the partial state before explicitly resuming the missing bindings.

## Real contract check

The test must execute API calls **as the runtime SA**. The operator's own object permissions are not
evidence that runtime IAM is correct. Temporarily grant the operator only
`iam.serviceAccounts.getAccessToken` on this exact runtime SA, using a custom role. For example, an
authorized administrator can create/reuse `projects/mfmf-499612/roles/mfmfRuntimeContractImpersonator`
with that single permission and bind it to the confirmed operator on the runtime SA. Existing role
contents must be checked before reuse. Remove precisely that temporary member/role binding afterward.
The broader predefined Service Account Token Creator role is unnecessary for this test. The permanent
runtime self-signBlob binding remains separate.
IAM policy reads can reflect a grant before token issuance does. Allow propagation time, checking only
the fixed permission; do not repeatedly mutate the policy or broaden the role to bypass a transient 403.

```bash
# Without --execute, no cloud call is made.
node scripts/gcp/test-storage-contract.mjs

# Explicit execution creates and then deletes isolated, randomly named tiny fixtures in both buckets.
node --experimental-strip-types --conditions=react-server scripts/gcp/test-storage-contract.mjs --execute
```

The script uses `gcloud auth print-access-token --impersonate-service-account=<fixed runtime>` in memory.
All GCS JSON API and self-signBlob calls then use that runtime token. Signed URLs, tokens, API bodies and
object identifiers are not printed. It tests CORS, exact size ±1, MIME/header tampering, valid upload,
create-only replay, actual image decoding, generation-bound rewrite and metadata replacement, deletion
followed by replay into incoming only, old-generation deletion isolation and final signed URL invalidation.
The live XML API rejects a missing signed header with `400 MalformedSecurityHeader`; altered signed
values are rejected with 403. The contract verifies that specific error code and checks that rejected
uploads created no live object. Cleanup verifies absence and reports only fixture counts and bytes.

The incoming replay intentionally demonstrates that generation zero is not a one-time credential.
Production must never authorize browser writes to final names. Cleanup only visits this run's random
fixture names and deletes the observed generation. If cleanup fails, inspect these isolated fixtures
before retrying. Soft-deleted fixtures remain billable for seven days, even after successful cleanup.
Expiry-over-time, application authorization/CAS races, migration reconciliation and operator restore
remain separate checks; this script does not claim to test them.

## Image and publication contract

New photo uploads are at most 10 MiB; avatars at most 2 MiB. JPEG/PNG/GIF/WebP/AVIF are decoded with sharp,
with a total 16-million-pixel cap across frames and one verification at a time per process (busy calls
fail promptly). SVG, HEIC and mislabeled/invalid data are rejected. The UI must show an appropriate
Japanese error and must not silently claim it uploaded an unsupported original file.

`signUpload` fixes exact size, content type and `x-goog-if-generation-match: 0` in a five-minute V4 PUT.
`publish` verifies the exact source generation and rewrites it with destination generation zero. All
custom metadata is replaced by server-derived binding metadata, with private/no-store and inline
response metadata. Binding fields are schema/state/kind/entityId/householdId/ownerId/reservationId/
sourceGeneration; storage keys are lowercase (`mfmf-entity-id`, etc.). `household-avatar` has a null owner,
profile has a null household, and photo entityId is the record ID. Generation values remain strings.

Final GET URLs include the immutable generation and expire within one hour. Generation-specific deletion
prevents a delayed delete from removing replacement data. Soft-delete restore is operator-only, assigns
a new generation and therefore requires a deliberate DB/provider-binding update before publication.
The runtime adapter intentionally provides no restore operation.

Official references: [XML headers](https://docs.cloud.google.com/storage/docs/xml-api/reference-headers),
[preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions),
[signing permissions](https://docs.cloud.google.com/storage/docs/access-control/signing-urls-with-helpers),
[CORS](https://docs.cloud.google.com/storage/docs/cross-origin),
[rewrite](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/rewrite),
[soft delete](https://docs.cloud.google.com/storage/docs/soft-delete),
[restore](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/restore).
