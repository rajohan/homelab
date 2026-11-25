"""Single-use, on-node receipt that survives an explicitly requested PVE reboot."""
import fcntl
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path("/var/lib/homelab-dashboard/restarts")
BOOT = Path("/proc/sys/kernel/random/boot_id")


def command(args, timeout=15):
    return subprocess.check_output(args, timeout=timeout, stderr=subprocess.DEVNULL, text=True).strip()


def write(directory, filename, data):
    temporary = directory / (filename + ".tmp")
    with temporary.open("w") as handle:
        json.dump(data, handle)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(directory / filename)
    fd = os.open(directory, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def guests():
    node = socket.gethostname().split(".")[0]
    items = json.loads(command(["/usr/bin/pvesh", "get", "/cluster/resources", "--type", "vm", "--output-format", "json"]))
    return {str(int(x["vmid"])): (x["type"], x["status"]) for x in items if x["node"] == node}


def prepare():
    node = socket.gethostname().split(".")[0]
    if command(["/usr/bin/systemctl", "is-enabled", "pve-guests.service"]) != "enabled":
        raise RuntimeError("Guest startup is not persistently enabled")
    for service in ("pve-guests.service", "pve-cluster.service"):
        command(["/usr/bin/systemctl", "is-active", service])
    tasks = json.loads(command(["/usr/bin/pvesh", "get", "/nodes/" + node + "/tasks", "--source", "active", "--output-format", "json"]))
    if tasks:
        raise RuntimeError("PVE has active tasks")
    listing = guests()
    for identifier, (kind, state) in listing.items():
        if kind not in ("qemu", "lxc") or state not in ("running", "stopped"):
            raise RuntimeError("Unexpected guest state")
        tool = "/usr/sbin/qm" if kind == "qemu" else "/usr/sbin/pct"
        config = command([tool, "config", identifier]).splitlines()
        if any(line.startswith("lock:") for line in config) or (state == "running") != ("onboot: 1" in config):
            raise RuntimeError("Guest startup or lock prevents verified reboot")
    return sorted(identifier for identifier, (_, state) in listing.items() if state == "running")


def execute(directory):
    request = json.loads((directory / "request.json").read_text())
    with (ROOT / "controller.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if json.loads((directory / "receipt.json").read_text())["state"] != "accepted":
            return
        try:
            if request["boot"] != BOOT.read_text().strip() or time.time() >= request["expires"]:
                raise RuntimeError("Confirmation changed")
            expected_guests = prepare()
            if time.time() >= request["expires"]:
                raise RuntimeError("Confirmation expired")
            write(directory, "receipt.json", {"state": "verifying", "guests": expected_guests})
        except Exception:
            write(directory, "receipt.json", {"state": "refused"})
            return
        # Once journaled, even a lost command acknowledgement is reconciled by boot and guest evidence.
        try:
            command(["/usr/bin/systemctl", "--no-block", "reboot"])
        except (OSError, subprocess.SubprocessError):
            pass


def read(directory):
    path = directory / "receipt.json"
    if not path.exists():
        return "missing"
    result = json.loads(path.read_text())
    if result["state"] != "verifying":
        return result["state"]
    request = json.loads((directory / "request.json").read_text())
    if BOOT.read_text().strip() == request["boot"]:
        return "verifying"
    try:
        for service in ("pve-guests.service", "pve-cluster.service"):
            command(["/usr/bin/systemctl", "is-active", service])
        running = {i for i, (_, state) in guests().items() if state == "running"}
        if running != set(result["guests"]):
            return "verifying"
        command(request["health"])
    except (OSError, ValueError, subprocess.SubprocessError):
        return "verifying"
    with (directory / "receipt.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = json.loads(path.read_text())
        if current["state"] == "verifying":
            write(directory, "receipt.json", {"state": "verified"})
            return "verified"
        return current["state"]


def main():
    os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == "execute":
        execute(ROOT / str(uuid.UUID(sys.argv[2])))
        return
    request = json.load(sys.stdin)
    identifier = str(uuid.UUID(request["id"]))
    directory = ROOT / identifier
    if request["mode"] == "submit":
        target = request["target"]
        if not (target.get("physicalNode") is True and target["kind"] == "host" and not request.get("requiredOnly")
                and time.time() < request["expires"] <= time.time() + 360):
            raise RuntimeError("Invalid manual PVE restart")
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            pass
        else:
            write(directory, "request.json", {"boot": request["expected"]["bootId"], "expires": request["expires"], "health": target["health"]})
            runner = directory / "runner.py"
            runner.write_text(request["program"])
            write(directory, "receipt.json", {"state": "accepted"})
            command(["/usr/bin/systemd-run", "--quiet", "--collect", "--property=RuntimeMaxSec=240",
                     "--unit=homelab-restart-" + identifier, "/usr/bin/python3", str(runner), "execute", identifier])
    elif request["mode"] != "read":
        raise RuntimeError("Unexpected mode")
    print(json.dumps({"state": read(directory)}))


if __name__ == "__main__":
    main()
