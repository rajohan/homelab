"""Fixed restart/observation program; stdin is composed by the worker, never the browser."""
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path


class MaintenanceRefused(Exception):
    """Definitive pre-mutation rejection, distinct from a missing acknowledgement."""


def run(argv, timeout=30):
    """Bound subprocess output and lifetime without a shell or inherited credentials."""
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C", "HOME": "/nonexistent"})
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Maintenance probe timeout")
                for key, _ in selector.select(0.2):
                    chunk = os.read(key.fd, 8192)
                    if not chunk:
                        selector.unregister(key.fd)
                    output.extend(chunk)
                    if len(output) > 65536:
                        raise RuntimeError("Maintenance output exceeded its budget")
        if child.wait(timeout=max(0.1, deadline-time.monotonic())) != 0:
            raise RuntimeError("Maintenance command failed")
        return output.decode("utf8").strip()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        child.stdout.close()


def owns_kernel():
    """A container can see an obsolete parent kernel. Only an independent kernel can be rebooted here."""
    try:
        detection = subprocess.run(["/usr/bin/systemd-detect-virt", "--container"], timeout=3,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"}, text=True)
    except (OSError, subprocess.SubprocessError):
        return None
    kind = detection.stdout.strip()
    if detection.returncode == 1 and kind == "none":
        return True
    if detection.returncode == 0 and kind and kind != "none":
        return False
    return None


def observe(target, full=True, include_fleet=False):
    """Read the boot identity and selected service; never return raw command output."""
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    active, invocation = None, None
    canonical = target.get("service")
    if target.get("reportedOn") and target.get("service") == "systemd-manager":
        active, invocation = "active", boot.replace("-", "")
    elif target["kind"] == "service":
        properties = dict(line.split("=", 1) for line in run([
            "/usr/bin/systemctl", "show", "--property=Id,ActiveState,InvocationID", "--", target["service"]
        ]).splitlines() if "=" in line)
        active = properties.get("ActiveState")
        canonical = properties.get("Id") or canonical
        invocation = properties.get("InvocationID") or None
        if (invocation is not None and not re.fullmatch(r"[a-f0-9]{32}", invocation)) or (active == "active" and not invocation):
            raise RuntimeError("Service invocation identity is unavailable")
    if active not in (None, "active", "inactive"):
        raise RuntimeError("Service is not in a stable state")
    required = Path("/var/run/reboot-required").exists()
    service_required = None
    evidence = None
    fleet = None
    actionable = False
    if target["kind"] == "service" and active == "inactive":
        evidence = "stopped"
    elif full:
        fleet = read_service_report(run)
        for item in fleet["services"]:
            if item["unit"] == "dbus.service" and item["restartable"]:
                item["busRecovery"] = bus_eligibility(target.get("systemBusProfile"))
        if fleet.pop("kernelOrMicrocodePending", False) and not required:
            required = owns_kernel()
        if target["kind"] == "service":
            evidence = fleet["evidence"]
            if evidence == "measured":
                entry = next((s for s in fleet["services"] if s["unit"] == canonical), None)
                service_required = entry is not None
                actionable = bool(entry and entry["restartable"] and entry["invocationId"] == invocation)
    result = {"serviceEvidence": evidence, "bootId": boot, "active": active, "invocationId": invocation, "rebootRequired": required, "serviceRestartRequired": service_required, "health": False}
    if canonical:
        result["canonicalUnit"] = canonical
    if (target["kind"] == "host" or include_fleet) and fleet is not None:
        result["fleet"] = fleet
    return result, actionable


def preflight(target):
    if target.get("preflight"):
        run(target["preflight"], timeout=10)
    ssh_check = ["/usr/sbin/sshd", "-t"]
    if target.get("reportedOn") and target.get("service") in ("ssh.service", "sshd.service") and target.get("preflight") != ssh_check:
        run(ssh_check, timeout=10)


def main():
    """Execute one bounded, worker-selected operation and emit only its observation."""
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise RuntimeError("Maintenance input exceeded its budget")
    request = json.loads(raw)
    target = request["target"]
    mode = request["mode"]
    bus_request = target.get("reportedOn") and target.get("service") == BUS_UNIT and request.get("operationId")
    # A delayed duplicate may refer to a helper that already sent the restart.
    # Reconcile that receipt even if the original service identity has since changed.
    if mode == "restart" and bus_request and bus_directory(request["operationId"]).exists():
        mode = "verify"
    try:
        before, _ = observe(target, mode == "inspect")
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
        if mode == "restart":
            raise MaintenanceRefused("preflight") from error
        raise
    system_bus = before.get("canonicalUnit") in ("dbus.service", "dbus-broker.service")
    if mode == "preflight":
        preflight(target)
        return before
    if mode == "restart":
        if not target.get("workerIndependent", True):
            raise MaintenanceRefused("authority")
        expected = request["expected"]
        if (before["bootId"], before["active"], before["invocationId"]) != (expected["bootId"], expected["active"], expected["invocationId"]):
            raise MaintenanceRefused("identity")
        if system_bus:
            if not (target.get("reportedOn") and target["service"] == before["canonicalUnit"] == "dbus.service" and request.get("operationId") and request.get("busProgram")):
                raise MaintenanceRefused("implementation")
            # The independent helper checks prerequisites and the current needrestart identity before sending once.
            bus_submit(request)
            return before
        try:
            preflight(target)
            require_report = target["kind"] == "service" and (target.get("reportedOn") or request.get("requiredOnly"))
            current, actionable = observe(target, bool(require_report))
            last, _ = observe(target, False) if require_report else (current, False)
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
            raise MaintenanceRefused("preflight") from error
        if (last["bootId"], last["active"], last["invocationId"]) != (expected["bootId"], expected["active"], expected["invocationId"]):
            raise MaintenanceRefused("identity")
        if target["kind"] == "host":
            if request.get("requiredOnly") and not last["rebootRequired"]:
                raise MaintenanceRefused("requirement")
            run(["/usr/bin/systemctl", "--no-block", "reboot"])
            return before
        if last["active"] != "active":
            raise MaintenanceRefused("identity")
        if target.get("reportedOn") and not actionable:
            raise MaintenanceRefused("prerequisites")
        if request.get("requiredOnly") and current["serviceRestartRequired"] is not True:
            raise MaintenanceRefused("requirement")
        if target.get("reportedOn") and target["service"] == "systemd-manager":
            run(["/usr/bin/systemctl", "daemon-reexec"], timeout=120)
        else:
            run(["/usr/bin/systemctl", "try-restart", "--", target["service"]], timeout=120)
    if mode in ("verify", "restart"):
        if system_bus or bus_request:
            state = bus_status(request["operationId"], request["expected"])
            if state == "refused":
                reason = json.loads((bus_directory(request["operationId"]) / "refusal").read_text())
                raise MaintenanceRefused(reason)
            if state != "verified":
                raise RuntimeError("System bus client recovery is unverified")
        deadline = time.monotonic() + (45 if mode == "restart" else 10)
        while True:
            try:
                run(target["health"], timeout=min(10, max(0.1, deadline-time.monotonic())))
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)
        after, _ = observe(target, include_fleet=True)
        if system_bus or bus_request:
            confirmed = json.loads((bus_directory(request["operationId"]) / "confirmed").read_text())
            if (after["bootId"] != request["expected"]["bootId"] or after["invocationId"] != confirmed["invocation"]
                    or bus_id() != confirmed["bus"]):
                raise RuntimeError("System bus identity changed during verification")
        if target["kind"] == "service" and after["active"] != "active":
            raise RuntimeError("Service did not recover")
        after["health"] = True
        return after
    if mode not in ("inspect", "state"):
        raise RuntimeError("Unsupported maintenance operation")
    return before


if __name__ == "__main__":
    def interrupted(_number, _frame):
        raise SystemExit(1)
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        print(json.dumps(main()), flush=True)
    except MaintenanceRefused as error:
        print(json.dumps({"restart":"not-started", "reason":str(error)}), flush=True)
        sys.exit(3)
    except Exception:
        sys.exit(1)
