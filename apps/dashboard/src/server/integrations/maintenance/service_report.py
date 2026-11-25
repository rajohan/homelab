"""Shared, read-only Linux report used by fleet inspection and installation receipts."""
from pathlib import Path
import re
import subprocess
import time


def service_unit_name(unit):
    """Accept literal systemd service names, including instance names and escaped characters."""
    return bool(len(unit) <= 255 and re.fullmatch(
        r"(?:[A-Za-z0-9:_.@-]|\\x[0-9A-Fa-f]{2})+\.service", unit))


def _service_properties(units, run, deadline):
    """Get systemd identities in batches without letting a vanished unit hide its peers."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {}
    try:
        output = run(["/usr/bin/systemctl", "show", "--all",
                      "--property=Id,Names,LoadState,ActiveState,SubState,CanStart,CanStop,RefuseManualStart,RefuseManualStop,InvocationID,Type,MainPID",
                      "--", *units], timeout=min(remaining, 5))
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
        if len(units) == 1:
            return {}
        middle = len(units) // 2
        return {**_service_properties(units[:middle], run, deadline),
                **_service_properties(units[middle:], run, deadline)}
    result = {}
    for block in re.split(r"\n\s*\n", output):
        properties = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        canonical = properties.get("Id", "")
        if not service_unit_name(canonical):
            continue
        for name in [canonical, *properties.get("Names", "").split()]:
            if name in units:
                result[name] = properties
    return result


def read_service_report(run):
    """List every unit reported by needrestart. Unresolved entries remain visible for manual review."""
    unavailable = {"evidence": "check-failed", "services": []}
    if not Path("/usr/sbin/needrestart").is_file():
        return {"evidence": "not-installed", "services": []}
    try:
        output = run(["/usr/sbin/needrestart", "-b", "-r", "l"], timeout=25)
        if not re.search(r"(?m)^NEEDRESTART-VER:[ \t]*\S+", output):
            return unavailable
        host_signal = bool(re.search(r"(?m)^(?:NEEDRESTART-KSTA:[ \t]*[23]|NEEDRESTART-UCSTA:[ \t]*2)[ \t]*$", output))
        if host_signal:
            unavailable["kernelOrMicrocodePending"] = True
        units = set()
        for line in output.splitlines():
            if not line.startswith("NEEDRESTART-SVC:"):
                continue
            unit = line.partition(":")[2].strip()
            if not unit or not unit.isprintable() or len(unit.encode("utf-8")) > 255:
                return unavailable
            units.add(unit)
        if len(units) > 1024:
            return unavailable
        boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
        return unavailable
    names = sorted(unit for unit in units if service_unit_name(unit))
    properties = {}
    deadline = time.monotonic() + 10
    for start in range(0, len(names), 32):
        properties.update(_service_properties(names[start:start + 32], run, deadline))
    services = {}
    alias_bytes = 0
    for unit in sorted(units):
        fields = properties.get(unit, {})
        canonical = fields.get("Id", unit)
        if canonical in services:
            continue
        invocation = fields.get("InvocationID", "")
        if not re.fullmatch(r"[0-9a-f]{32}", invocation) or invocation == "0" * 32:
            invocation = None
        restartable = bool(invocation and fields.get("LoadState") == "loaded" and
                           fields.get("ActiveState") == "active" and fields.get("SubState") == "running" and
                           fields.get("CanStart") == fields.get("CanStop") == "yes" and
                           fields.get("RefuseManualStart") == fields.get("RefuseManualStop") == "no" and
                           fields.get("Type") not in (None, "", "oneshot") and re.fullmatch(r"[1-9]\d*", fields.get("MainPID", "")))
        if unit == "systemd-manager":
            invocation = boot.replace("-", "")
            restartable = bool(re.fullmatch(r"[0-9a-f]{32}", invocation))
        entry = {"unit": canonical, "invocationId": invocation, "restartable": restartable}
        aliases = sorted({name for name in fields.get("Names", "").split()
                          if name != canonical and service_unit_name(name)})[:64]
        cost = sum(len(name) + 3 for name in aliases)
        if aliases and alias_bytes + cost <= 131072:
            entry["aliases"] = aliases
            alias_bytes += cost
        services[canonical] = entry
    report = {"evidence": "measured", "services": list(services.values())}
    if host_signal:
        report["kernelOrMicrocodePending"] = True
    return report
