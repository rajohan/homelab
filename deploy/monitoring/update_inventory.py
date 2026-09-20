#!/usr/bin/env python3
"""Publish read-only software observations using an individually scoped automation token."""

import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

from native_inventory import collect_native


def timestamp(seconds=None):
    """Format UTC observation timestamps without local-time ambiguity."""
    instant = datetime.datetime.now(datetime.timezone.utc) if seconds is None else datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return instant.isoformat().replace("+00:00", "Z")


def command(arguments, version=False):
    """Run a fixed read-only program invocation; never propagate raw failure output."""
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=15, check=False, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "HOME": "/nonexistent"})
    output = result.stdout + (result.stderr if version else "")
    if result.returncode or len(output) > 2_000_000:
        raise RuntimeError("A local inventory source is unavailable")
    return output


def apt_inventory():
    """Read installed/candidate versions using APT's own Debian version comparison."""
    import apt
    import apt_pkg

    cache = apt.Cache()
    rows = []
    for package in cache:
        if not package.is_installed:
            continue
        installed = package.installed
        candidate = package.candidate
        rows.append({
            "id": "apt:" + package.fullname,
            "name": package.fullname,
            "kind": "os",
            "installed": installed.version,
            "available": candidate.version if candidate else None,
            "status": ("available" if apt_pkg.version_compare(candidate.version, installed.version) > 0 else "current") if candidate else "unknown",
            "security": bool(candidate and package.is_upgradable and any("security" in origin.archive for origin in candidate.origins)),
            "held": package._pkg.selected_state == apt_pkg.SELSTATE_HOLD,
        })
    indexes = [path.stat().st_mtime for path in Path("/var/lib/apt/lists").glob("*InRelease") if path.is_file()]
    refresh = Path("/var/lib/apt/periodic/update-success-stamp")
    # InRelease mtimes may describe upstream publication, not a successful refresh.
    # Without APT's success stamp, the oldest known index is a conservative fallback.
    metadata = refresh.stat().st_mtime if refresh.is_file() else (min(indexes) if indexes else None)
    return rows, timestamp(metadata) if metadata is not None else None


def runtime_inventory(configuration):
    """Inspect explicitly configured runtimes without loading application identity state."""
    rows = []
    for name, executable in configuration.get("executables", {}).items():
        if name not in {"bun", "node", "github-cli"} or not Path(executable).is_absolute():
            raise ValueError("Unsupported runtime inventory configuration")
        output = command([executable, "--version"]).splitlines()[0]
        match = re.search(r"(?<![0-9])v?([0-9]+[.][0-9]+[.][0-9]+(?:-[A-Za-z0-9.-]+)?)", output)
        rows.append({"id": "runtime:" + name, "name": name, "kind": "runtime", "installed": match.group(1) if match else "Not reported", "available": None, "status": "unknown", "release": name})
    manifest = configuration.get("openclawManifest")
    if manifest:
        if not Path(manifest).is_absolute() or Path(manifest).stat().st_size > 1_000_000:
            raise ValueError("Invalid OpenClaw package manifest")
        with open(manifest, encoding="utf-8") as source:
            package = json.load(source)
        if package.get("name") != "openclaw" or not isinstance(package.get("version"), str):
            raise ValueError("Unexpected application package manifest")
        rows.append({"id": "application:openclaw", "name": "OpenClaw", "kind": "application", "installed": package["version"], "available": None, "status": "unknown", "release": "openclaw"})
    return rows


def docker_inventory(projects, tracking=None):
    """Read only explicit Compose projects and local image metadata; never pull or control containers."""
    rows = []
    for project in projects:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,79}", project):
            raise ValueError("Invalid Docker inventory project")
        ids = command(["/usr/bin/docker", "ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=" + project]).split()
        for container_id in ids:
            if not re.fullmatch(r"[a-f0-9]{64}", container_id):
                raise ValueError("Invalid container identity")
            # Format at the source so environment values, mounts and credentials are never collected.
            metadata = json.loads("[" + command(["/usr/bin/docker", "inspect", "--format", '{{json .Name}},{{json .Config.Image}},{{json .Image}}', container_id]).strip() + "]")
            name, image, image_id = metadata
            platform = json.loads("[" + command(["/usr/bin/docker", "image", "inspect", "--format", '{{json .Os}},{{json .Architecture}},{{json .Variant}}', image_id]).strip() + "]")
            os_name, architecture, variant = platform
            channel = (tracking or {}).get(name.lstrip("/"))
            if channel is not None and (not isinstance(channel, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", channel)):
                raise ValueError("Invalid image tracking tag")
            rows.append({"id": "docker:" + container_id, "name": name.lstrip("/"), "kind": "container", "installed": image_id, "available": None, "status": "unknown", "image": image, "held": False, "pinned": "@" in image, **({"imageTag": channel} if channel is not None else {}), "platform": {"os": os_name, "architecture": architecture, **({"variant": variant} if variant else {})}})
    return rows


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward an automation bearer credential to a redirected endpoint."""

    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def collect(configuration):
    """Collect each enabled source independently and retain failures as incomplete reports."""
    report = {"capturedAt": timestamp(), "repositoryMetadataAt": None, "complete": True, "coveredKinds": [], "items": []}
    if configuration.get("apt", True):
        report["coveredKinds"].append("os")
        try:
            rows, metadata = apt_inventory()
            report["items"].extend(rows)
            report["repositoryMetadataAt"] = metadata
        except (ImportError, OSError, RuntimeError, ValueError, SystemError):
            report["complete"] = False
    if configuration.get("executables"):
        report["coveredKinds"].append("runtime")
    if configuration.get("openclawManifest") or configuration.get("nativeApplications"):
        report["coveredKinds"].append("application")
    try:
        report["items"].extend(runtime_inventory(configuration))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        report["complete"] = False
    if configuration.get("nativeApplications"):
        try:
            rows, complete = collect_native(configuration["nativeApplications"], lambda arguments: command(arguments, version=True))
            report["items"].extend(rows)
            report["complete"] = report["complete"] and complete
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            report["complete"] = False
    if configuration.get("dockerProjects"):
        report["coveredKinds"].append("container")
        try:
            report["items"].extend(docker_inventory(configuration["dockerProjects"], configuration.get("imageTrackingTags")))
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
            report["complete"] = False
    if not report["coveredKinds"] or len(report["items"]) > 5000:
        raise ValueError("Inventory is unconfigured or exceeds its item budget")
    return report


def main():
    """Print an observation or send it once to the configured dashboard automation endpoint."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--print", action="store_true", dest="print_report")
    arguments = parser.parse_args()
    with open(arguments.config, encoding="utf-8") as source:
        configuration = json.load(source)
    report = collect(configuration)
    if arguments.print_report:
        print(json.dumps(report, separators=(",", ":")))
        return
    origin = os.environ.get("HOMELAB_DASHBOARD_ORIGIN", "")
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ValueError("A credential-free HTTPS dashboard origin is required")
    token = os.environ.get("HOMELAB_DASHBOARD_UPDATE_TOKEN")
    if not token:
        raise ValueError("A scoped update publisher token is required")
    body = json.dumps({"json": report}, separators=(",", ":")).encode()
    if len(body) > 950_000:
        raise ValueError("Inventory exceeds the request budget")
    request = urllib.request.Request(origin.rstrip("/") + "/api/automation/updates.publish", data=body, method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
        result = json.loads(response.read(65_537))
        envelope = result.get("result") if isinstance(result, dict) else None
        data = envelope.get("data") if isinstance(envelope, dict) else None
        payload = data.get("json") if isinstance(data, dict) else None
        if not isinstance(payload, dict) or payload.get("accepted") is not True:
            raise RuntimeError("Inventory delivery failed")
    print("Update inventory delivered.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, urllib.error.URLError, subprocess.SubprocessError):
        raise SystemExit("Update inventory failed; check source availability and scoped configuration.")
