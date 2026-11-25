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


def observe(target, full=True):
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
    if target["kind"] == "host" and fleet is not None:
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
    before, _ = observe(target, mode == "inspect")
    if mode == "preflight":
        preflight(target)
        return before
    if mode == "restart":
        if not target.get("workerIndependent", True):
            raise RuntimeError("This target requires an external restart")
        expected = request["expected"]
        if (before["bootId"], before["active"], before["invocationId"]) != (expected["bootId"], expected["active"], expected["invocationId"]):
            raise RuntimeError("Restart target changed")
        preflight(target)
        require_report = target["kind"] == "service" and (target.get("reportedOn") or request.get("requiredOnly"))
        current, actionable = observe(target, bool(require_report))
        last, _ = observe(target, False) if require_report else (current, False)
        if (last["bootId"], last["active"], last["invocationId"]) != (expected["bootId"], expected["active"], expected["invocationId"]):
            raise RuntimeError("Restart target changed during preflight")
        if target["kind"] == "host":
            if request.get("requiredOnly") and not last["rebootRequired"]:
                raise RuntimeError("Host restart is no longer required")
            run(["/usr/bin/systemctl", "--no-block", "reboot"])
            return before
        if last["active"] != "active":
            raise RuntimeError("A stopped service must not be started by restart")
        if target.get("reportedOn") and not actionable:
            raise RuntimeError("Reported service is no longer restartable")
        if request.get("requiredOnly") and current["serviceRestartRequired"] is not True:
            raise RuntimeError("Service restart is no longer required")
        if target.get("reportedOn") and target["service"] == "systemd-manager":
            run(["/usr/bin/systemctl", "daemon-reexec"], timeout=120)
        else:
            run(["/usr/bin/systemctl", "try-restart", "--", target["service"]], timeout=120)
    if mode in ("verify", "restart"):
        deadline = time.monotonic() + (45 if mode == "restart" else 10)
        while True:
            try:
                run(target["health"], timeout=min(10, max(0.1, deadline-time.monotonic())))
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(1)
        after, _ = observe(target)
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
    except Exception:
        sys.exit(1)
