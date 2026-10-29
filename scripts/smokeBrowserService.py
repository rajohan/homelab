"""Qualify only disposable browser/database resources, without production configuration."""
import os
import pathlib
import subprocess
import time
import uuid

root = pathlib.Path(__file__).resolve().parent.parent
name = "homelab-browser-service-" + uuid.uuid4().hex
subprocess.run(["docker", "run", "-d", "--rm", "--tmpfs", "/var/lib/postgresql:rw,size=512m", "--name", name,
                "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=homelab_test", "-e", "POSTGRES_PASSWORD=isolated-test-only-password",
                "-e", "POSTGRES_DB=homelab_auth_test", "postgres:18"], check=True, stdout=subprocess.DEVNULL)
try:
    for _ in range(100):
        if subprocess.run(["docker", "exec", name, "pg_isready", "-U", "homelab_test", "-d", "homelab_auth_test"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.1)
    port = subprocess.check_output(["docker", "port", name, "5432/tcp"], text=True).strip().split(":")[-1]
    if not port.isdecimal():
        raise RuntimeError("Invalid disposable database port")
    environment = {key: value for key, value in os.environ.items() if not key.startswith("HOMELAB_")}
    environment["HOMELAB_TEST_DATABASE_URL"] = f"postgres://homelab_test:isolated-test-only-password@127.0.0.1:{port}/homelab_auth_test"
    subprocess.run(["bun", "--no-env-file", "apps/dashboard/src/server/testing/miraBrowserServiceSmoke.ts"], cwd=root, env=environment, check=True, timeout=150)
finally:
    subprocess.run(["docker", "rm", "-f", name], check=True, stdout=subprocess.DEVNULL)
