"""PVE-owned single-execution receipt for a reviewed VM or guest service restart."""
import fcntl
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path("/var/lib/homelab-dashboard/restarts")
QM = "/usr/sbin/qm"


def receipt(directory, state):
    temporary = directory / "receipt.tmp"
    with temporary.open("w") as handle:
        json.dump({"state": state}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(directory / "receipt.json")


def guest(vmid, args, timeout=12):
    data = subprocess.check_output(
        [QM, "guest", "exec", str(vmid), "--timeout", str(timeout), "--", *args],
        timeout=timeout + 8, stderr=subprocess.DEVNULL)
    report = json.loads(data)
    if not report.get("exited") or report.get("exitcode") != 0:
        raise RuntimeError("Guest command not confirmed")
    return report.get("out-data", "").strip()


def identity(vmid, service):
    boot = guest(vmid, ["/usr/bin/cat", "/proc/sys/kernel/random/boot_id"])
    if not service:
        return boot, None
    state = guest(vmid, ["/usr/bin/systemctl", "show", "-p", "ActiveState", "-p", "InvocationID", service])
    fields = dict(line.split("=", 1) for line in state.splitlines())
    return boot, fields.get("InvocationID") if fields.get("ActiveState") == "active" else None


def execute(directory):
    request = json.loads((directory / "request.json").read_text())
    recipe, expected = request["target"], request["expected"]
    vmid, service = recipe["proxmox"]["vmid"], recipe.get("service")
    sent = False
    try:
        with (ROOT / "controller.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if identity(vmid, service) != (expected["bootId"], expected["invocationId"]):
                raise RuntimeError("Guest identity changed")
            if service and not expected["invocationId"]:
                raise RuntimeError("Service is stopped")
            if recipe.get("preflight"):
                guest(vmid, recipe["preflight"])
            if time.time() >= request["expires"]:
                raise RuntimeError("Confirmation expired")
            receipt(directory, "verifying")
            sent = True
            try:
                if service:
                    guest(vmid, ["/usr/bin/systemctl", "try-restart", service], 90)
                else:
                    subprocess.run([QM, "reboot", str(vmid), "--timeout", "90"], check=True, timeout=105)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                pass  # Only a fresh identity and a passing health probe can confirm the outcome.
            deadline = time.monotonic() + 420
            while time.monotonic() < deadline:
                try:
                    boot, invocation = identity(vmid, service)
                    changed = (boot == expected["bootId"] and invocation and invocation != expected["invocationId"]) if service else boot != expected["bootId"]
                    if changed:
                        guest(vmid, recipe["health"])
                        receipt(directory, "verified")
                        return
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                    pass
                time.sleep(4)
            receipt(directory, "unverified")
    except Exception:
        receipt(directory, "unverified" if sent else "refused")


def main():
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == "execute":
        execute(ROOT / str(uuid.UUID(sys.argv[2])))
        return
    request = json.load(sys.stdin)
    identifier = str(uuid.UUID(request["id"]))
    directory = ROOT / identifier
    if request["mode"] == "submit" and not directory.exists():
        if not time.time() < request["expires"] <= time.time() + 360:
            raise RuntimeError("Confirmation expired")
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            pass
        else:
            (directory / "request.json").write_text(json.dumps({key:request[key] for key in ("target","expected","expires")}))
            runner = directory / "runner.py"
            runner.write_text(request["program"])
            receipt(directory, "accepted")
            subprocess.run(["/usr/bin/systemd-run", "--quiet", "--collect", "--property=RuntimeMaxSec=610",
                            "--unit=homelab-restart-" + identifier, "/usr/bin/python3", str(runner), "execute", identifier],
                           check=True, timeout=10)
    path = directory / "receipt.json"
    print(path.read_text() if path.exists() else '{"state":"missing"}')


if __name__ == "__main__":
    main()
