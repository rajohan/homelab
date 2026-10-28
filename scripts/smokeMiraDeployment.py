"""Qualify the actual Compose overlays with synthetic settings and disposable containers."""
import base64
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/nonexistent"}


def command(arguments, environment=None, timeout=90):
    """Run bounded local Docker operations without ambient provider or remote-context credentials."""
    result = subprocess.run(arguments, cwd=ROOT, env=environment or ENVIRONMENT,
                            capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError("Mira deployment qualification command failed: " + result.stderr[-3000:])
    return result.stdout


def request(port, path, method="GET", headers=None, expected=404):
    """Assert a bounded HTTP response through the real loopback-published container port."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    value = urllib.request.Request("http://127.0.0.1:" + str(port) + path,
                                   data=b"{}" if method == "POST" else None,
                                   headers=headers or {}, method=method)
    try:
        with opener.open(value, timeout=5) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
    assert status == expected, (path, status, expected)


def main():
    """Prove optional listener routing, public refusal, recreation and disable without production state."""
    prefix = os.environ.get("HOMELAB_SMOKE_IMAGE_PREFIX", "")
    if not re.fullmatch(r"[a-z0-9][a-z0-9./_-]*", prefix):
        raise RuntimeError("Set HOMELAB_SMOKE_IMAGE_PREFIX to the locally built image namespace.")
    version = json.loads(command(["docker", "version", "--format", "{{json .Server.Version}}"]))
    if int(version.split(".", 1)[0]) < 28:
        raise RuntimeError("Loopback publication qualification requires Docker Engine 28 or newer.")
    command(["docker", "image", "inspect", prefix + "/dashboard:tested"])
    command(["docker", "image", "inspect", "postgres:18"])
    owner = "mira-deployment-" + uuid.uuid4().hex
    reservation = owner + "-reservation"
    reserved = False
    base = None
    with tempfile.TemporaryDirectory(prefix=owner + "-") as temporary:
        directory = Path(temporary).resolve()
        try:
            # Let Docker allocate an unused subnet; the actual overlay then recreates that
            # network with explicit IPAM. A concurrent allocation fails rather than reusing a network.
            command(["docker", "network", "create", "--label", "homelab.smoke=" + owner, reservation])
            reserved = True
            network = json.loads(command(["docker", "network", "inspect", reservation]))[0]
            subnet = ipaddress.ip_network(network["IPAM"]["Config"][0]["Subnet"])
            assert subnet.version == 4 and subnet.num_addresses > 8
            address = str(subnet.network_address + 2)
            files = directory / "files"
            files.mkdir(mode=0o755)
            settings = {
                **ENVIRONMENT,
                "HOMELAB_MIRA_IMAGE": prefix + "/mira:tested",
                "HOMELAB_DASHBOARD_IMAGE": prefix + "/dashboard:tested",
                "HOMELAB_MIRA_CONFIG": str(directory / "unused-runtime.json"),
                "HOMELAB_MIRA_CODEX_HOME": str(directory / "unused-codex"),
                "HOMELAB_MIRA_FILES_DIR": str(files),
                "HOMELAB_MIRA_GITHUB_OWNER": "deployment-operator",
                "HOMELAB_MIRA_GITHUB_TOKEN": "synthetic-executor-only-token",
                "HOMELAB_MIRA_COMPUTER_HOST": address,
                "HOMELAB_MIRA_COMPUTER_SUBNET": str(subnet),
                "HOMELAB_MIRA_COMPUTER_DYNAMIC_RANGE": str(list(subnet.subnets(prefixlen_diff=1))[1]),
            }
            render = ["docker", "compose", "--env-file", "/dev/null", "--project-name", owner]
            for file in ["compose.yaml", "compose.dashboard-image.yaml", "compose.worker.yaml", "compose.mira.yaml"]:
                render += ["--file", str(ROOT / "deploy" / file)]
            baseline = json.loads(command(render + ["config", "--format", "json"], settings))
            services = baseline["services"]
            assert services["dashboard"]["environment"]["HOMELAB_MIRA_GITHUB_OWNER"] == "deployment-operator"
            assert services["mira"]["environment"]["HOMELAB_MIRA_GITHUB_OWNER"] == "deployment-operator"
            assert services["mira"]["environment"]["HOMELAB_MIRA_GITHUB_TOKEN"] == "synthetic-executor-only-token"
            for name in ["dashboard", "worker", "auth"]:
                assert "HOMELAB_MIRA_GITHUB_TOKEN" not in services[name]["environment"]
            assert "HOMELAB_MIRA_COMPUTER_HOST" not in services["dashboard"]["environment"]
            assert all(port["target"] != 3113 for port in services["dashboard"]["ports"])
            unconfigured = {key: value for key, value in settings.items() if not key.startswith("HOMELAB_MIRA_GITHUB_")}
            disabled = json.loads(command(render + ["config", "--format", "json"], unconfigured))
            for name in ["dashboard", "mira"]:
                for key in ["HOMELAB_MIRA_GITHUB_OWNER", "HOMELAB_MIRA_GITHUB_TOKEN"]:
                    assert disabled["services"][name]["environment"].get(key) is None
            enabled = json.loads(command(render + ["--file", str(ROOT / "deploy/compose.computer.yaml"), "config", "--format", "json"], settings))
            dashboard = enabled["services"]["dashboard"]
            assert dashboard["networks"]["default"]["ipv4_address"] == address
            assert dashboard["environment"]["HOMELAB_MIRA_COMPUTER_HOST"] == address
            assert dashboard["environment"]["HOMELAB_MIRA_COMPUTER_PORT"] == "3113"
            assert next(port for port in dashboard["ports"] if port["target"] == 3113)["host_ip"] == "127.0.0.1"
            # Use the rendered deployment definition, changing only synthetic identity/database
            # settings, local image selection, host port allocation and fixture resource limits.
            dashboard.pop("build", None)
            dashboard["pull_policy"] = "never"
            dashboard["mem_limit"] = "512m"
            dashboard["cpus"] = 1
            dashboard["pids_limit"] = 128
            for port in dashboard["ports"]:
                assert port["host_ip"] == "127.0.0.1"
                port["published"] = "0"
            dashboard["environment"].update({
                "HOMELAB_DASHBOARD_DATABASE_URL": "postgres://fixture:synthetic-only@database:5432/homelab_fixture",
                "HOMELAB_DASHBOARD_AUTH_ISSUER": "https://auth.example.test",
                "HOMELAB_DASHBOARD_ORIGIN": "https://dashboard.example.test",
                "HOMELAB_DASHBOARD_OIDC_CLIENT_ID": "synthetic-dashboard",
                "HOMELAB_DASHBOARD_OIDC_CLIENT_SECRET": "synthetic-client-secret",
                "HOMELAB_DASHBOARD_SESSION_KEY": base64.b64encode(bytes([19]) * 32).decode(),
            })
            dashboard["healthcheck"].update({"interval": "1s", "start_period": "1s", "retries": 20})
            fixture = {"services": {"dashboard": dashboard, "database": {
                "image": "postgres:18", "pull_policy": "never", "read_only": True,
                "tmpfs": ["/var/lib/postgresql:rw,size=256m", "/var/run/postgresql:rw,size=4m", "/tmp:rw,size=16m"],
                "environment": {"POSTGRES_USER": "fixture", "POSTGRES_PASSWORD": "synthetic-only", "POSTGRES_DB": "homelab_fixture"},
                "mem_limit": "384m", "cpus": 1, "pids_limit": 128,
                "healthcheck": {"test": ["CMD", "pg_isready", "-U", "fixture", "-d", "homelab_fixture"], "interval": "1s", "retries": 20},
            }}, "networks": enabled["networks"]}
            file = directory / "compose.json"
            file.write_text(json.dumps(fixture))
            base = ["docker", "compose", "--env-file", "/dev/null", "--project-name", owner, "--file", str(file)]
            command(["docker", "network", "rm", reservation])
            reserved = False
            command(base + ["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "30", "database"])
            command(base + ["run", "--rm", "--no-deps", "--entrypoint", "bun", "dashboard", "--no-env-file", "migrate.js", "--apply"])

            def inspect():
                identifier = command(base + ["ps", "--quiet", "dashboard"]).strip()
                result = json.loads(command(["docker", "inspect", identifier]))[0]
                assert result["Config"]["Labels"]["com.docker.compose.project"] == owner
                assert result["NetworkSettings"]["Networks"][owner + "_default"]["IPAddress"] == address
                ports = result["NetworkSettings"]["Ports"]
                assert all(binding["HostIp"] == "127.0.0.1" for bindings in ports.values() if bindings for binding in bindings)
                return identifier, {int(key.split("/")[0]): int(value[0]["HostPort"]) for key, value in ports.items() if value}

            previous = None
            for _ in range(2):
                command(base + ["up", "--detach", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "30", "dashboard"])
                identifier, ports = inspect()
                assert identifier != previous
                previous = identifier
                request(ports[3100], "/health/ready", expected=200)
                request(ports[3100], "/api/mira/computers/connect")
                request(ports[3100], "/api/mira/computers/connect", "POST")
                request(ports[3113], "/api/mira/computers/connect", expected=405)
                request(ports[3113], "/api/mira/computers/connect", "POST", {"Content-Type": "application/json"}, 403)
                request(ports[3113], "/api/mira/computers/connect", "POST", {"Origin": "https://dashboard.example.test"}, 403)
                request(ports[3113], "/api/trpc")
                request(ports[3113], "/")
            for key in ["HOMELAB_MIRA_COMPUTER_HOST", "HOMELAB_MIRA_COMPUTER_PORT"]:
                dashboard["environment"].pop(key)
            dashboard["ports"] = [port for port in dashboard["ports"] if port["target"] != 3113]
            file.write_text(json.dumps(fixture))
            command(base + ["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "30", "dashboard"])
            _, ports = inspect()
            assert 3113 not in ports
            request(ports[3100], "/health/ready", expected=200)
            request(ports[3100], "/api/mira/computers/connect")
            print("Mira deployment passed: scoped GitHub configuration; private receiver; public refusal; recreate and disable.")
        finally:
            try:
                if base:
                    command(base + ["down", "--volumes", "--remove-orphans", "--timeout", "10"])
            finally:
                if reserved:
                    command(["docker", "network", "rm", reservation])


if __name__ == "__main__":
    main()
