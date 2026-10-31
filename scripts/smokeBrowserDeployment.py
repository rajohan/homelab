"""Qualify proxy replacement against real, isolated Docker networks and baked proxy images."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deployment_host", ROOT / "apps/dashboard/src/server/integrations/releases/deploymentHost.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
ENVIRONMENT = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/nonexistent"}


def command(arguments, environment=None, data=None):
    """Use fixed local Docker/Bun entrypoints with bounded synthetic output."""
    result = subprocess.run(arguments, cwd=ROOT, env=environment or ENVIRONMENT, input=data,
                            capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError("Browser replacement qualification failed: " + result.stderr[-2000:])
    return result.stdout


def cleanup(compose, tags):
    """Attempt every fixture cleanup without hiding the original qualification error."""
    failures = []
    if compose:
        try:
            command(compose + ["down", "--volumes", "--remove-orphans", "--timeout", "5"])
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            failures.append("disposable Compose project")
    for tag in tags:
        try:
            command(["docker", "image", "rm", tag])
        except (OSError, RuntimeError, subprocess.TimeoutExpired):
            try:
                remaining = command(["docker", "image", "ls", "--quiet", "--no-trunc", "--filter", "reference=" + tag])
                if remaining.strip():
                    failures.append(tag)
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                failures.append(tag)
    if failures:
        message = "Browser qualification cleanup could not confirm removal: " + ", ".join(failures)
        original = sys.exception()
        if original:
            original.add_note(message)
        else:
            raise RuntimeError(message)


def main():
    """Recreate both proxies, preserve isolated slots and verify refreshed IDs with the real browser guard."""
    original = json.loads(command(["docker", "image", "inspect", "homelab-browser-proxy-test:local"]))[0]["Id"]
    owner = "homelab-proxy-upgrade-" + uuid.uuid4().hex
    candidate = owner + ":candidate"
    compose = None
    with tempfile.TemporaryDirectory(prefix=owner) as temporary:
        directory = Path(temporary)
        ENVIRONMENT["HOME"] = temporary
        try:
            # Only metadata changes; the real maintained proxy and its baked policy are unchanged.
            command(["docker", "image", "tag", original, owner + ":base"])
            command(["docker", "build", "--tag", candidate, "-"], data="FROM " + owner + ":base\nLABEL homelab.smoke=" + owner + "\n")
            replacement = json.loads(command(["docker", "image", "inspect", candidate]))[0]["Id"]
            assert replacement != original
            environment = {**ENVIRONMENT, "HOMELAB_MIRA_BROWSER_PROXY_IMAGE": original,
                "HOMELAB_MIRA_IMAGE": "unused:synthetic", "HOMELAB_DOCKER_GID": "998",
                "HOMELAB_MIRA_FILES_DIR": str(directory / "unused-files"),
                "HOMELAB_MIRA_BROWSER_CONFIG": str(directory / "unused-host.json")}
            rendered = json.loads(command(["docker", "compose", "--env-file", "/dev/null", "--project-name", owner,
                "--file", "deploy/compose.browser.yaml", "config", "--format", "json"], environment))
            rendered["services"].pop("mira-browser-host")
            rendered["networks"].pop("default", None)
            # No public connectivity is needed to verify identity and health. Keep every network offline.
            rendered["networks"]["mira-browser-outbound"].update(internal=True, driver_opts={"com.docker.network.bridge.gateway_mode_ipv4": "isolated"})
            for service in rendered["services"].values():
                service["pull_policy"] = "never"
                service["restart"] = "no"
                assert not service.get("ports") and not service.get("volumes")
            path = directory / "compose.json"
            path.write_text(json.dumps(rendered))
            compose = ["docker", "compose", "--env-file", "/dev/null", "--project-name", owner, "--file", str(path)]
            target = {"directory": temporary, "project": owner, "units": ["fixture.service", "proxy.service"],
                "browserProxyUnits": ["proxy.service"],
                "services": [{"name": name, "app": "mira-browser-proxy"} for name in rendered["services"]]}
            command(compose + ["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "45"])
            before = {entry["name"]: host.container(target, entry["name"]) for entry in target["services"]}
            slots = []
            for suffix in ["a", "b"]:
                network = json.loads(command(["docker", "network", "inspect", owner + "_mira-browser-" + suffix]))[0]["Id"]
                proxy = before["mira-browser-proxy-" + suffix]
                slots.append({"networkId": network, "proxyId": proxy["id"], "proxyImageId": proxy["imageId"]})
            browser = {"imageId": "sha256:" + "a"*64, "networks": slots}
            bindings = host.browser_bindings(target, browser, before)
            assert host.browser_slots(target, bindings, before) == slots
            command(compose + ["stop", "--timeout", "5"])
            for service in rendered["services"].values():
                service["image"] = replacement
            path.write_text(json.dumps(rendered))
            command(compose + ["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "45"])
            after = {entry["name"]: host.container(target, entry["name"]) for entry in target["services"]}
            refreshed = host.browser_slots(target, bindings, after)
            assert [slot["networkId"] for slot in refreshed] == [slot["networkId"] for slot in slots]
            assert all(refreshed[index]["proxyId"] != slots[index]["proxyId"] and refreshed[index]["proxyImageId"] == replacement for index in range(2))
            try:
                host.browser_bindings(target, browser, after)
            except host.Refusal:
                pass
            else:
                raise AssertionError("Stale proxy identities were accepted")
            # The production TypeScript guard independently checks the complete baked-policy boundary.
            probe = "import {browserDockerRequest} from './apps/mira/src/server/browsing/docker'; import {verifyBrowserEgress} from './apps/mira/src/server/browsing/egress'; const call=browserDockerRequest('/run/docker.sock'); for(const slot of JSON.parse(process.argv[1]!)) await verifyBrowserEgress(call,slot);"
            command(["bun", "--no-env-file", "-e", probe, json.dumps(refreshed)])
            print("PASS: both real proxy replacements retained isolated network IDs; refreshed container/image IDs pass the browser guard")
        finally:
            cleanup(compose, [candidate, owner + ":base"])


if __name__ == "__main__":
    main()
