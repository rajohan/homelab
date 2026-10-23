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


def observe(target):
    """Read the boot identity and selected service; never return raw command output."""
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    active, invocation = None, None
    if target["kind"] == "service":
        properties = dict(line.split("=", 1) for line in run([
            "/usr/bin/systemctl", "show", "--property=ActiveState", "--property=InvocationID", target["service"]
        ]).splitlines() if "=" in line)
        active = properties.get("ActiveState")
        invocation = properties.get("InvocationID") or None
        if (invocation is not None and not re.fullmatch(r"[a-f0-9]{32}", invocation)) or (active == "active" and not invocation):
            raise RuntimeError("Service invocation identity is unavailable")
    if active not in (None, "active", "inactive"):
        raise RuntimeError("Service is not in a stable state")
    required = Path("/var/run/reboot-required").exists()
    service_required = None
    if target["kind"] == "service" and Path("/usr/sbin/needrestart").is_file():
        try:
            output = run(["/usr/sbin/needrestart", "-b", "-r", "l"])
            service_required = target["service"] in re.findall(r"(?m)^NEEDRESTART-SVC:\s*(\S+)\s*$", output)
        except RuntimeError:
            pass
    return {"bootId": boot, "active": active, "invocationId": invocation, "rebootRequired": required, "serviceRestartRequired": service_required, "health": False}


def main():
    """Execute one bounded, worker-selected operation and emit only its observation."""
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise RuntimeError("Maintenance input exceeded its budget")
    request = json.loads(raw)
    target = request["target"]
    before = observe(target)
    mode = request["mode"]
    if mode == "preflight":
        if target.get("preflight"):
            run(target["preflight"], timeout=10)
        return before
    if mode == "restart":
        if not target.get("workerIndependent", True):
            raise RuntimeError("This target requires an external restart")
        expected = request["expected"]
        if (before["bootId"], before["active"], before["invocationId"]) != (expected["bootId"], expected["active"], expected["invocationId"]):
            raise RuntimeError("Restart target changed")
        if target.get("preflight"):
            run(target["preflight"], timeout=10)
        if target["kind"] == "host":
            run(["/usr/bin/systemctl", "--no-block", "reboot"])
            return before
        if before["active"] != "active":
            raise RuntimeError("A stopped service must not be started by restart")
        run(["/usr/bin/systemctl", "restart", target["service"]], timeout=120)
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
        after = observe(target)
        if target["kind"] == "service" and after["active"] != "active":
            raise RuntimeError("Service did not recover")
        after["health"] = True
        return after
    if mode != "inspect":
        raise RuntimeError("Unsupported maintenance operation")
    return before


if __name__ == "__main__":
    def interrupted(_number, _frame):
        raise RuntimeError("Maintenance interrupted")
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        print(json.dumps(main()), flush=True)
    except Exception:
        sys.exit(1)
