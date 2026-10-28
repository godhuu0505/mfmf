#!/usr/bin/env python3
"""Synthetic operator proof. Never accepts a database URL or production inputs."""
from pathlib import Path
import argparse
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = "mfmf-db-operator-test:local"
DB_IMAGE = "mfmf-gcp-postgres-test:17"


def command(args, check=True):
    result = subprocess.run(args, text=True, capture_output=True, timeout=900)
    if check and result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-build", action="store_true")
    args = parser.parse_args()
    if not args.skip_build:
        command(["docker", "build", "-f", str(ROOT / "tests/gcp/postgres.Dockerfile"), "-t", DB_IMAGE, str(ROOT / "tests/gcp")])
        command(["docker", "build", "-f", str(ROOT / "Dockerfile.gcp-operator"), "-t", IMAGE, str(ROOT)])
    name = "mfmf-operator-proof-" + uuid.uuid4().hex[:12]
    started = False
    try:
        command(["docker", "run", "--detach", "--rm", "--name", name, "--network", "none", "--tmpfs", "/var/lib/postgresql/data:rw", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", DB_IMAGE])
        started = True
        # The entrypoint temporary init server has a Unix socket but no TCP.
        # Wait for the final server, not the socket that disappears on restart.
        for _ in range(60):
            if command(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], False).returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("Disposable PostgreSQL did not start")
        result = command(["docker", "run", "--rm", "--network", "container:" + name,
                          "--entrypoint", "node", IMAGE, "/app/tests/gcp/operator-proof.mjs"])
        print(result.stdout.strip())
    finally:
        if started:
            command(["docker", "rm", "--force", name], False)


if __name__ == "__main__":
    main()
