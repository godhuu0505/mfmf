#!/usr/bin/env python3
"""Synthetic, isolated PostgreSQL 17 proof; never connects to a supplied database.

Creates one randomly named, network-disabled Docker container with tmpfs data,
then removes that exact container even on failure. No .env or existing DB is read.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "mfmf-gcp-postgres-test:17"
LEGACY = [
    "guest_grants_test.sql", "guest_invites_test.sql",
    "household_invites_test.sql", "household_provisioning_test.sql",
    "household_rls_test.sql", "schedule_test.sql",
]


def command(args, *, data=None, check=True):
    result = subprocess.run(args, input=data, text=True, capture_output=True,
                            timeout=600 if args[:2] == ["docker", "build"] else 180)
    if check and result.returncode:
        # This runner accepts synthetic sources only, never a production archive.
        raise RuntimeError(result.stdout + result.stderr)
    return result


def adapt_legacy(sql):
    """Only adapt fixture identity shape / fixture role; assertions are unchanged."""
    def users(match):
        body = re.sub(r"\(\s*('[^']*')\s*,\s*('[^']*')\s*\)", r"(\1,\2,true)", match[1])
        return "insert into auth.users(id,email,email_verified) values" + body + ";"
    sql = re.sub(r"insert into auth\.users\s*\(id,\s*email\)\s*values(.*?);", users, sql, flags=re.S | re.I)
    sql = re.sub(r"\bbegin;", "begin;\nset local role mfmf_owner;\nset local search_path=public,extensions;\nselect set_config('request.jwt.claims','{}',true);", sql, count=1, flags=re.I)
    return re.sub(r"\breset role;", "set local role mfmf_owner;", sql, flags=re.I)


def compare_catalogs(source, target):
    """Exact original contract, with a small explicit GCS/identity difference list."""
    changed = {
        "columns": {"media_storage_state.mode", "media_storage_state.read_backend"},
        "constraints": {"media_storage_state.media_storage_state_mode_check", "media_storage_state.media_storage_state_read_backend_check"},
        "functions": {"media_is_operator()", "set_media_storage_mode(p_mode text)",
                      "get_media_storage_mode()", "delete_own_household(p_household_id uuid)"},
    }
    removed = {"functions": {"media_storage_object_guard()"}}
    added = {
        "functions": {"sync_identity(p_subject text, p_email text, p_email_verified boolean, p_allow_create boolean)"},
        "policies": {"media_assets.media_assets_operator", "media_storage_state.media_state_operator",
                     "record_ranking_project_budget.ranking_project_owner", "record_ranking_user_budget.ranking_user_owner"},
        "triggers": {"users.identity_binding_immutable"},
    }
    for category, original in source.items():
        actual = target[category]
        if set(original) - set(actual) != removed.get(category, set()):
            raise RuntimeError("Baseline removed unexpected " + category)
        if set(actual) - set(original) != added.get(category, set()):
            raise RuntimeError("Baseline added unexpected " + category)
        for key in set(original) & set(actual):
            if original[key] != actual[key] and key not in changed.get(category, set()):
                raise RuntimeError("Baseline contract changed: " + category + " / " + key)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    expected = json.loads((ROOT / "db/gcp/source-migrations.json").read_text())
    actual = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT / "supabase/migrations").glob("*.sql"))}
    if actual != expected:
        raise RuntimeError("Source migrations changed: review and regenerate GCP baseline first")
    if not args.skip_build:
        command(["docker", "build", "-f", str(ROOT / "tests/gcp/postgres.Dockerfile"), "-t", IMAGE, str(ROOT / "tests/gcp")])
    name = "mfmf-gcp-proof-" + uuid.uuid4().hex[:12]
    started = False
    try:
        command(["docker", "run", "--detach", "--rm", "--name", name, "--network", "none",
                 "--tmpfs", "/var/lib/postgresql/data:rw", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE])
        started = True
        # The entrypoint temporary init server has a Unix socket but no TCP.
        # Wait for the final server, not the socket that disappears on restart.
        for _ in range(60):
            if command(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], check=False).returncode == 0:
                break
            time.sleep(0.5)
        else:
            raise RuntimeError("Isolated PostgreSQL did not start")

        def sql(text, user="postgres", database="mfmf", check=True):
            return command(["docker", "exec", "-i", name, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database], data=text, check=check)

        sql("CREATE DATABASE mfmf;", database="postgres")
        sql((ROOT / "db/gcp/000_roles.sql").read_text())
        # Replay EVERY original migration in another database. Minimal platform
        # scaffolding exists only there; no Storage schema reaches the target.
        sql("CREATE ROLE service_role NOLOGIN; CREATE DATABASE mfmf_source;", database="postgres")
        sql((ROOT / "tests/gcp/source-shim.sql").read_text(), database="mfmf_source")
        for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            sql(migration.read_text(), database="mfmf_source")
        baseline = "BEGIN; SET ROLE mfmf_owner;\n" + "\n".join(
            (ROOT / "db/gcp" / part).read_text() for part in ["010_identity.sql", "020_public.sql", "030_permissions.sql"]
        ) + "\nCOMMIT;"
        sql(baseline, "mfmf_migrator")
        print("baseline: applied by NOSUPERUSER/NOBYPASSRLS migrator")
        def catalog(database):
            result = command(["docker", "exec", "-i", name, "psql", "-XAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database],
                             data=(ROOT / "tests/gcp/catalog-contract.sql").read_text())
            return json.loads(result.stdout)
        compare_catalogs(catalog("mfmf_source"), catalog("mfmf"))
        print("source parity: all migrations replayed; tables/columns/constraints/RLS/functions/triggers verified")
        sql("""CREATE EXTENSION pgtap WITH SCHEMA extensions;
CREATE ROLE proof_driver LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT mfmf_owner, authenticated, anon, identity_sync, media_operator TO proof_driver;
GRANT USAGE ON SCHEMA extensions TO proof_driver, identity_sync, authenticator;
ALTER DATABASE mfmf SET search_path=public,extensions;
""")
        sql("SET ROLE media_operator; SELECT public.set_media_storage_mode('gcs');", "mfmf_operator")
        command(["docker", "exec", name, "mkdir", "-p", "/tmp/proof"])
        paths = []
        for filename in LEGACY:
            adapted = adapt_legacy((ROOT / "supabase/tests" / filename).read_text())
            path = "/tmp/proof/legacy_" + filename
            command(["docker", "exec", "-i", name, "sh", "-c", 'cat > "$1"', "sh", path], data=adapted)
            paths.append(path)
        for path in sorted((ROOT / "tests/gcp").glob("db_*.sql")):
            command(["docker", "cp", str(path), name + ":/tmp/proof/" + path.name])
            paths.append("/tmp/proof/" + path.name)
        result = command(["docker", "exec", name, "pg_prove", "-U", "proof_driver", "-d", "mfmf", *paths])
        print(result.stdout.strip())
        # Real LOGIN boundary: the test driver cannot stand in for authenticator.
        denial_cases = [
            "SET ROLE mfmf_owner", "SET ROLE media_operator", "CREATE TABLE public.escalation(id int)",
            "SELECT public.sync_identity('victim','victim@example.test',true)",
            "TRUNCATE public.daycare_records", "SELECT * FROM auth.users",
        ]
        for query in denial_cases:
            outcome = sql("BEGIN; SET LOCAL ROLE authenticated; " + query + "; ROLLBACK;", "authenticator", check=False)
            if outcome.returncode == 0 or "permission denied" not in outcome.stderr:
                raise RuntimeError("Authenticator privilege boundary failed: " + query)
        print("authenticator: owner/operator/schema/identity-sync/TRUNCATE/auth-users denied")
        bounded = sql("SELECT current_setting('statement_timeout')='8s' AND current_setting('idle_in_transaction_session_timeout')='10s' AS bounded;", "authenticator")
        if not re.search(r"\bt\b", bounded.stdout):
            raise RuntimeError("Runtime SQL timeout missing")
        # Transaction claims disappear on COMMIT and after errors/ROLLBACK.
        check = sql("""BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"10000000-0000-4000-8000-000000000001"}',true);
COMMIT; BEGIN; SET LOCAL ROLE authenticated;
SELECT CASE WHEN auth.uid() IS NULL THEN 'claims-reset-ok' ELSE 'claims-leaked' END; ROLLBACK;
""", "authenticator")
        if "claims-reset-ok" not in check.stdout or "claims-leaked" in check.stdout:
            raise RuntimeError("Transaction identity leaked")
        print("claims: transaction boundary reset verified")
        # Restore a full synthetic public/auth mirror data dump into another
        # newly provisioned DB. No trigger disabling, replication-role bypass,
        # superuser restore, or real archive input is permitted by this runner.
        sql((ROOT / "tests/gcp/restore-seed.sql").read_text(), "mfmf_migrator")
        command(["docker", "exec", name, "pg_dump", "-U", "mfmf_migrator", "--role=mfmf_owner",
                 "-d", "mfmf", "--format=custom", "--data-only", "--inserts", "--column-inserts",
                 "--enable-row-security", "--no-owner", "--no-privileges", "--schema=auth", "--schema=public",
                 "--exclude-table-data=public.media_storage_state", "--file=/tmp/proof/restore.dump"])
        sql("CREATE DATABASE mfmf_restored;", database="postgres")
        sql("""GRANT CREATE ON DATABASE mfmf_restored TO mfmf_owner;
ALTER SCHEMA public OWNER TO mfmf_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA extensions AUTHORIZATION mfmf_owner;
CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO mfmf_owner,authenticated,anon,proof_driver,identity_sync;
ALTER DATABASE mfmf_restored SET search_path=public,extensions;
""", database="mfmf_restored")
        sql(baseline, "mfmf_migrator", database="mfmf_restored")
        dump_sql = command(["docker", "exec", name, "pg_restore", "--no-owner", "--no-privileges", "--enable-row-security", "--file=-", "/tmp/proof/restore.dump"]).stdout
        sql("BEGIN; SET ROLE mfmf_owner; DELETE FROM public.record_ranking_project_budget;\n" + dump_sql + "\nCOMMIT;",
            "mfmf_migrator", database="mfmf_restored")
        sql("CREATE EXTENSION pgtap WITH SCHEMA extensions;", database="mfmf_restored")
        command(["docker", "cp", str(ROOT / "tests/gcp/restore-proof.sql"), name + ":/tmp/proof/restore-proof.sql"])
        result = command(["docker", "exec", name, "pg_prove", "-U", "proof_driver", "-d", "mfmf_restored", "/tmp/proof/restore-proof.sql"])
        print(result.stdout.strip())
        print("restore: UUIDs, tenant isolation, image generation/tombstones, encrypted token, budget and frozen mode verified")
    finally:
        if started:
            command(["docker", "rm", "--force", name], check=False)


if __name__ == "__main__":
    main()
