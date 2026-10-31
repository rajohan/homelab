"""Rehearse an installed dashboard upgrade and database recovery with synthetic data.

Both images must already exist locally. No registry, production database, provider
credentials, ingress or system service is used. The previous image creates its
own schema so the test exercises the real packaged migration boundary.
"""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid


ENVIRONMENT = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/nonexistent"}
DATABASE = "postgres://fixture:synthetic-only@database:5432/fixture"
TABLES = {
    "worker_control": "id=1",
    "job_schedules": "action='fixture.held'",
    "update_policies": "target='fixture-held'",
    "operation_audit": "actor='fixture-operator'",
    "operation_snapshots": "key='fixture'",
    "dashboard_notifications": "source='fixture'",
    "notification_receipts": "actor='fixture-operator'",
}
SEED = """
INSERT INTO worker_control (id, paused, version, updated_by) VALUES (1, true, 7, 'fixture-operator');
INSERT INTO job_schedules (id,action,enabled,schedule,disable_reason,version,next_run_at)
VALUES ('00000000-0000-4000-8000-000000000001','fixture.held',false,
'{"kind":"interval","seconds":300}', 'Keep this automation paused during migration',9,'2099-01-01Z');
INSERT INTO update_policies (target,enabled,version,configuration) VALUES ('fixture-held',false,4,'fixture-config');
INSERT INTO operation_audit (id,actor,action,target,message)
VALUES ('00000000-0000-4000-8000-000000000002','fixture-operator','fixture.action','fixture','Preserve audit history');
INSERT INTO operation_snapshots (key,value,captured_at) VALUES ('fixture', '{"preserved":true}', '2026-01-01Z');
INSERT INTO dashboard_notifications (id,source,source_key,title,message,severity,destination)
VALUES ('00000000-0000-4000-8000-000000000003','fixture','upgrade','Synthetic notification','Preserve read state','info','jobs');
INSERT INTO notification_receipts (notification_id,actor,read_at)
VALUES ('00000000-0000-4000-8000-000000000003','fixture-operator','2026-01-02Z');
"""


def command(arguments, data=None, timeout=90):
    """Run only bounded local fixture commands with a scrubbed environment."""
    result = subprocess.run(arguments, input=data, env=ENVIRONMENT, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError("Upgrade qualification command failed: " + result.stderr.decode(errors="replace")[-2000:])
    return result.stdout


def image(reference):
    """Resolve a supplied local image once, then use its immutable ID throughout."""
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,255}", reference):
        raise ValueError("An explicit local image reference is required")
    value = json.loads(command(["docker", "image", "inspect", reference]))[0]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", value["Id"]):
        raise ValueError("Invalid local image identity")
    return value["Id"]


def wait(predicate, seconds=45):
    """Bound readiness without assuming a fixed container startup delay."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    raise RuntimeError("Upgrade qualification readiness deadline exceeded")


def cleanup(containers, network):
    """Attempt every owned cleanup, tolerate absent containers and preserve the original failure."""
    failures = []
    for name in sorted(containers):
        try:
            result = subprocess.run(["docker", "rm", "--force", name], env=ENVIRONMENT, capture_output=True, timeout=30)
            if result.returncode:
                remaining = subprocess.run(["docker", "ps", "--all", "--quiet", "--no-trunc", "--filter", "name=^/" + name + "$"],
                                           env=ENVIRONMENT, capture_output=True, timeout=10)
                if remaining.returncode or remaining.stdout.strip():
                    failures.append(name)
        except (OSError, subprocess.TimeoutExpired):
            failures.append(name)
    if network:
        try:
            command(["docker", "network", "rm", network])
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            failures.append(network)
    if failures:
        message = "Qualification cleanup could not confirm removal: " + ", ".join(failures)
        original = sys.exception()
        if original:
            original.add_note(message)
        else:
            raise RuntimeError(message)


def main():
    """Verify preservation, schema refusal, idempotence, worker readiness and actual restore."""
    if len(sys.argv) != 3:
        raise ValueError("Usage: smokeDashboardUpgrade.py <previous-local-image> <candidate-local-image>")
    previous, candidate = (image(value) for value in sys.argv[1:])
    if previous == candidate:
        raise ValueError("Upgrade qualification requires distinct images")
    postgres = image("postgres:18")
    owner = "homelab-upgrade-test-" + uuid.uuid4().hex
    database = owner + "-db"
    containers = set()
    columns = {}
    network_created = False
    settings = {
        "NODE_ENV": "production", "HOMELAB_DASHBOARD_DATABASE_URL": DATABASE,
        "HOMELAB_DASHBOARD_AUTH_ISSUER": "https://auth.example.test",
        "HOMELAB_DASHBOARD_ORIGIN": "https://dashboard.example.test",
        "HOMELAB_DASHBOARD_OIDC_CLIENT_ID": "synthetic-dashboard",
        "HOMELAB_DASHBOARD_OIDC_CLIENT_SECRET": "synthetic-client-secret",
        "HOMELAB_DASHBOARD_SESSION_KEY": base64.b64encode(bytes([39]) * 32).decode(),
        "HOMELAB_DASHBOARD_HOST": "0.0.0.0", "HOMELAB_DASHBOARD_PORT": "3100",
        "HOMELAB_DASHBOARD_WORKER_HOST": "0.0.0.0", "HOMELAB_DASHBOARD_WORKER_PORT": "3112",
        "HOMELAB_DASHBOARD_WORKER_CONCURRENCY": "3",
    }

    def sql(statement):
        return command(["docker", "exec", "-i", database, "psql", "-X", "-v", "ON_ERROR_STOP=1",
                        "-U", "fixture", "-d", "fixture", "-At"], statement.encode()).decode().strip()

    def snapshots():
        return {table: json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM (SELECT " + columns[table] + " FROM " + table + " WHERE " + predicate + ") t;")) for table, predicate in TABLES.items()}

    def remove(name):
        command(["docker", "rm", "--force", name])
        containers.remove(name)

    def start(selected, entrypoint, should_start=True):
        name = owner + "-" + uuid.uuid4().hex[:8]
        arguments = ["docker", "run", "--detach", "--name", name, "--network", owner,
                     "--label", "homelab.smoke=" + owner, "--read-only", "--cap-drop=ALL",
                     "--security-opt=no-new-privileges:true", "--memory", "512m", "--cpus", "1",
                     "--pids-limit", "128", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--init"]
        for key, value in settings.items():
            arguments += ["--env", key + "=" + value]
        containers.add(name)
        command(arguments + [selected, "bun", "--no-env-file", entrypoint])
        port = 3112 if entrypoint == "worker.js" else 3100

        def ready():
            state = json.loads(command(["docker", "inspect", name]))[0]["State"]
            if not state["Running"]:
                if should_start:
                    logs = command(["docker", "logs", name]).decode(errors="replace")
                    raise RuntimeError("Fixture unexpectedly exited: " + logs[-2000:])
                assert state["ExitCode"] != 0, state
                output = subprocess.run(["docker", "logs", name], env=ENVIRONMENT, capture_output=True, timeout=10)
                logs = (output.stdout + output.stderr).decode(errors="replace")
                assert "Dashboard migrations do not match this build" in logs, logs[-2000:]
                return True
            result = subprocess.run(["docker", "exec", name, "bun", "--no-env-file", "-e",
                                     "const r=await fetch('http://127.0.0.1:" + str(port) + "/health/ready');process.exit(r.status===" + ("200" if should_start else "503") + "?0:1)"],
                                    env=ENVIRONMENT, capture_output=True, timeout=10)
            return result.returncode == 0

        wait(ready)
        return name

    def migrate(selected):
        name = owner + "-migration-" + uuid.uuid4().hex[:8]
        containers.add(name)
        command(["docker", "run", "--name", name, "--network", owner, "--label", "homelab.smoke=" + owner,
                 "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                 "--memory", "512m", "--pids-limit", "64", "--tmpfs", "/tmp:rw,size=32m",
                 "--env", "HOMELAB_DASHBOARD_DATABASE_URL=" + DATABASE,
                 selected, "bun", "--no-env-file", "migrate.js", "--apply"])
        remove(name)

    try:
        command(["docker", "network", "create", "--internal", "--label", "homelab.smoke=" + owner, owner])
        network_created = True
        containers.add(database)
        command(["docker", "run", "--detach", "--name", database, "--network", owner, "--network-alias", "database",
                 "--label", "homelab.smoke=" + owner, "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
                 "--tmpfs", "/var/lib/postgresql:rw,size=512m", "--env", "POSTGRES_USER=fixture",
                 "--env", "POSTGRES_PASSWORD=synthetic-only", "--env", "POSTGRES_DB=fixture", postgres])
        wait(lambda: subprocess.run(["docker", "exec", database, "pg_isready", "-h", "127.0.0.1", "-U", "fixture"],
                                   env=ENVIRONMENT, capture_output=True, timeout=5).returncode == 0)
        migrate(previous)
        sql(SEED)
        for table in TABLES:
            columns[table] = sql("SELECT string_agg(quote_ident(column_name),',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='" + table + "';")
        before = snapshots()
        remove(start(previous, "index.js"))
        remove(start(candidate, "index.js", False))
        with tempfile.TemporaryDirectory(prefix=owner) as temporary:
            backup = Path(temporary) / "database.dump"
            backup.write_bytes(command(["docker", "exec", database, "pg_dump", "-U", "fixture", "-d", "fixture", "--format=custom"]))
            command(["docker", "exec", "-i", database, "pg_restore", "--list"], backup.read_bytes())
            migrate(candidate)
            migrate(candidate)
            assert snapshots() == before, "Existing operator state changed during migration"
            remove(start(previous, "index.js", False))
            dashboard = start(candidate, "index.js")
            worker = start(candidate, "worker.js")
            assert sql("SELECT bool_and(paused AND version=7) FROM worker_control;") == "t"
            assert sql("SELECT count(*) FROM workers WHERE capacity=3 AND reserved_capacity=1 AND deployment_protocol=1;") == "1"
            remove(worker)
            remove(dashboard)
            assert snapshots() == before, "Starting candidate services changed preserved operator state"
            # Rehearse recovery on this same synthetic database, not an unrelated empty database.
            sql("DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public;")
            command(["docker", "exec", "-i", database, "pg_restore", "--exit-on-error", "-U", "fixture", "-d", "fixture"], backup.read_bytes())
            assert snapshots() == before, "Backup restoration did not preserve operator state"
            remove(start(previous, "index.js"))
            remove(start(candidate, "index.js", False))
        print("PASS: packaged upgrade, preserved pauses/history, idempotent migrations, schema refusal, worker capacity and restored database")
    finally:
        cleanup(containers, owner if network_created else None)


if __name__ == "__main__":
    main()
