#!/usr/bin/env bash
# Encrypt before publishing: only the public recipient is needed by CI.
set -euo pipefail
umask 077

: "${SUPABASE_BACKUP_AGE_RECIPIENT:?Set the age public recipient before backing up production}"
output_dir="${1:?Usage: backup-db.sh <new-output-directory>}"
if [[ -e "$output_dir" ]]; then
  echo "Backup output directory already exists; refusing to overwrite it." >&2
  exit 1
fi
command -v age >/dev/null
command -v supabase >/dev/null

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

# Reject an invalid recipient before querying production.
age --encrypt --recipient "$SUPABASE_BACKUP_AGE_RECIPIENT" \
  --output "$work_dir/recipient-check.age" < /dev/null
mkdir "$work_dir/encrypted"

supabase db dump --linked --schema public --file "$work_dir/schema.sql"
supabase db dump --linked --schema public --data-only --file "$work_dir/data.sql"
for kind in schema data; do
  if [[ ! -s "$work_dir/$kind.sql" ]]; then
    echo "Empty $kind dump; refusing to publish a backup." >&2
    exit 1
  fi
  age --encrypt --recipient "$SUPABASE_BACKUP_AGE_RECIPIENT" \
    --output "$work_dir/encrypted/pre-migrate-$kind.sql.age" "$work_dir/$kind.sql"
done

# Publish only after both dumps and encryptions succeed. Plain SQL stays in the
# private temporary directory and is removed by the EXIT trap, including errors.
mkdir -p "$(dirname "$output_dir")"
mv "$work_dir/encrypted" "$output_dir"
