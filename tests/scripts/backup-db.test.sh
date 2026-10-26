#!/usr/bin/env bash
# Real age round trip, with a fake Supabase CLI: never contact a database.
set -euo pipefail
umask 077
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir "$test_dir/bin" "$test_dir/tmp"
export TMPDIR="$test_dir/tmp"
export BACKUP_TEST_CALLS="$test_dir/calls"
export BACKUP_TEST_AGE_BIN
BACKUP_TEST_AGE_BIN=$(command -v age)
age-keygen -o "$test_dir/identity.txt" 2>/dev/null
export SUPABASE_BACKUP_AGE_RECIPIENT
SUPABASE_BACKUP_AGE_RECIPIENT=$(age-keygen -y "$test_dir/identity.txt")
cat > "$test_dir/bin/supabase" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo called >> "$BACKUP_TEST_CALLS"
kind=schema
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data-only) kind=data ;;
    --file) shift; output=$1 ;;
  esac
  shift
done
if [[ "${BACKUP_TEST_FAIL:-}" == "$kind" ]]; then exit 1; fi
if [[ "${BACKUP_TEST_EMPTY:-}" == "$kind" ]]; then : > "$output"; exit; fi
printf '%s\n' "dummy-$kind-for-backup-test" > "$output"
STUB
chmod +x "$test_dir/bin/supabase"
cat > "$test_dir/bin/age" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${BACKUP_TEST_FAIL_ENCRYPT:-}" == 1 && "$*" == *pre-migrate-data.sql.age* ]]; then
  exit 1
fi
exec "$BACKUP_TEST_AGE_BIN" "$@"
STUB
chmod +x "$test_dir/bin/age"
export PATH="$test_dir/bin:$PATH"

bash "$repo_dir/scripts/backup-db.sh" "$test_dir/success" > "$test_dir/output.log" 2>&1
if grep -q 'dummy-' "$test_dir/output.log"; then exit 1; fi
for kind in schema data; do
  printf '%s\n' "dummy-$kind-for-backup-test" > "$test_dir/expected"
  age --decrypt --identity "$test_dir/identity.txt" \
    "$test_dir/success/pre-migrate-$kind.sql.age" | cmp - "$test_dir/expected"
done
[[ $(find "$test_dir/success" -type f | wc -l | tr -d ' ') == 2 ]]
[[ -z $(find "$TMPDIR" -mindepth 1 -print -quit) ]]

for failure in missing-recipient invalid-recipient dump-failure empty-dump encryption-failure existing-output; do
  rm -f "$BACKUP_TEST_CALLS"
  case "$failure" in
    missing-recipient)
      if SUPABASE_BACKUP_AGE_RECIPIENT= bash "$repo_dir/scripts/backup-db.sh" "$test_dir/rejected" 2>/dev/null; then exit 1; fi
      [[ ! -e "$BACKUP_TEST_CALLS" ]] ;;
    invalid-recipient)
      if SUPABASE_BACKUP_AGE_RECIPIENT=invalid bash "$repo_dir/scripts/backup-db.sh" "$test_dir/rejected" 2>/dev/null; then exit 1; fi
      [[ ! -e "$BACKUP_TEST_CALLS" ]] ;;
    dump-failure)
      if BACKUP_TEST_FAIL=data bash "$repo_dir/scripts/backup-db.sh" "$test_dir/rejected" 2>/dev/null; then exit 1; fi ;;
    empty-dump)
      if BACKUP_TEST_EMPTY=data bash "$repo_dir/scripts/backup-db.sh" "$test_dir/rejected" 2>/dev/null; then exit 1; fi ;;
    encryption-failure)
      if BACKUP_TEST_FAIL_ENCRYPT=1 bash "$repo_dir/scripts/backup-db.sh" "$test_dir/rejected" > "$test_dir/output.log" 2>&1; then exit 1; fi
      if grep -q 'dummy-' "$test_dir/output.log"; then exit 1; fi ;;
    existing-output)
      if bash "$repo_dir/scripts/backup-db.sh" "$test_dir/success" 2>/dev/null; then exit 1; fi
      [[ ! -e "$BACKUP_TEST_CALLS" ]] ;;
  esac
  [[ ! -e "$test_dir/rejected" ]]
  [[ -z $(find "$TMPDIR" -mindepth 1 -print -quit) ]]
done
echo 'Backup encryption: round trip and 6 failure cases passed.'
