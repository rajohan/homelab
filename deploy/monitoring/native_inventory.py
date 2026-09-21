"""Bounded observations of explicitly registered, non-APT software installations."""

from pathlib import Path
import re
import subprocess


# Providers own their invocation. Configuration cannot inject shell commands or flags.
PROGRAMS = {
    "adguard-home": ("AdGuard Home", ["--version"]),
    "adguardhome-sync": ("AdGuard Home Sync", ["--version"]),
    "node-exporter": ("Node Exporter", ["--version"]),
    "smartctl-exporter": ("SMART Exporter", ["--version"]),
    "blackbox-exporter": ("Blackbox Exporter", ["--version"]),
    "alertmanager": ("Alertmanager", ["--version"]),
    "victoriametrics": ("VictoriaMetrics", ["-version"]),
    "alloy": ("Grafana Alloy", ["--version"]),
    "loki": ("Grafana Loki", ["-version"]),
    "traefik": ("Traefik", ["version"]),
    "code-server": ("Code Server", ["--version"]),
    "codex": ("Codex CLI", ["--version"]),
}
VERSION = re.compile(r"(?<![0-9])v?([0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)[A-Za-z0-9.-]*)?)")


def observed_version(source, command):
    """Read a fixed provider's version without evaluating application configuration."""
    provider = source["provider"]
    path = Path(source["path"])
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Native inventory requires an absolute installation path")
    if provider in PROGRAMS:
        output = command([str(path), *PROGRAMS[provider][1]])
        match = VERSION.search(output)
        if not match:
            raise ValueError("Installed version was not reported")
        return match.group(1)
    if provider == "pve-exporter" and not path.exists() and path.name == "METADATA" and path.parent.name.startswith("prometheus_pve_exporter-"):
        # The configured distribution path includes its old version. A verified
        # venv upgrade replaces that directory; find exactly one current metadata
        # file inside the same site-packages directory without executing Python.
        matches = list(path.parent.parent.glob("prometheus_pve_exporter-*.dist-info/METADATA"))
        if len(matches) != 1:
            raise ValueError("Python distribution metadata is ambiguous")
        path = matches[0]
    if path.stat().st_size > 1_000_000:
        raise ValueError("Version metadata exceeds its budget")
    content = path.read_text(encoding="utf-8")
    if provider in {"pgadmin", "pve-exporter"}:
        package = "pgadmin4" if provider == "pgadmin" else "prometheus-pve-exporter"
        if not re.search(r"^Name: " + re.escape(package) + r"$", content, re.M | re.I):
            raise ValueError("Unexpected Python distribution metadata")
        match = re.search(r"^Version: ([0-9]+\.[0-9]+(?:\.[0-9]+)?)$", content, re.M)
    elif provider == "nextcloud":
        match = re.search(r"\$OC_VersionString\s*=\s*['\"]([0-9]+\.[0-9]+\.[0-9]+)['\"]", content)
    else:
        raise ValueError("Unsupported native inventory provider")
    if not match:
        raise ValueError("Version metadata was not recognized")
    return match.group(1)


def collect_native(sources, command):
    """Retain failed installations as unknown rows instead of silently hiding their existence."""
    if not isinstance(sources, list) or len(sources) > 100:
        raise ValueError("Native inventory source budget exceeded")
    rows = []
    complete = True
    identifiers = set()
    for source in sources:
        identifier = source.get("id", source.get("provider", ""))
        provider = source.get("provider")
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,79}", identifier) or identifier in identifiers:
            raise ValueError("Native inventory IDs must be valid and unique")
        if provider not in PROGRAMS and provider not in {"pgadmin", "pve-exporter", "nextcloud"}:
            raise ValueError("Unsupported native inventory provider")
        identifiers.add(identifier)
        label = source.get("name", PROGRAMS[provider][0] if provider in PROGRAMS else provider)
        if not isinstance(label, str) or not 1 <= len(label) <= 200:
            raise ValueError("Invalid installation label")
        try:
            version = observed_version(source, command)
        except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError):
            version = "Not reported"
            complete = False
        rows.append({"id": "application:" + identifier, "name": label, "kind": "application", "installed": version, "available": None, "status": "unknown", "release": provider})
    return rows, complete
