"""PVE-owned single-execution receipt for a reviewed VM or guest service restart."""
import fcntl
import json
import os
import re
import socket
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
    fd = os.open(directory, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def guest(vmid, args, timeout=12):
    data = subprocess.check_output(
        [QM, "guest", "exec", str(vmid), "--timeout", str(timeout), "--", *args],
        timeout=timeout + 8, stderr=subprocess.DEVNULL)
    report = json.loads(data)
    if not report.get("exited") or report.get("exitcode") != 0 or report.get("out-truncated"):
        raise RuntimeError("Guest command not confirmed")
    return report.get("out-data", "").strip()


def identity(vmid, service):
    boot = guest(vmid, ["/usr/bin/cat", "/proc/sys/kernel/random/boot_id"])
    if str(uuid.UUID(boot)) != boot:
        raise RuntimeError("Guest boot identifier is unavailable")
    if not service:
        return boot, None
    if service == "systemd-manager":
        return boot, boot.replace("-", "")
    state = guest(vmid, ["/usr/bin/systemctl", "show", "-p", "ActiveState", "-p", "InvocationID", "--", service])
    fields = dict(line.split("=", 1) for line in state.splitlines())
    invocation = fields.get("InvocationID", "")
    if fields.get("ActiveState") != "active" or not re.fullmatch(r"[0-9a-f]{32}", invocation) or invocation == "0" * 32:
        return boot, None
    return boot, invocation


def pending(vmid, service):
    if not service:
        return guest(vmid, ["/usr/bin/python3", "-c", "from pathlib import Path; print(int(Path('/run/reboot-required').exists()))"]) == "1"
    output = guest(vmid, ["/usr/sbin/needrestart", "-b", "-r", "l"], 30)
    if not re.search(r"(?m)^NEEDRESTART-VER:[ \t]*\S+", output):
        raise RuntimeError("Restart report could not be verified")
    names = {service}
    if service != "systemd-manager":
        names.update(guest(vmid, ["/usr/bin/systemctl", "show", "-p", "Names", "--value", "--", service]).split())
    return any(line.partition(":")[2].strip() in names for line in output.splitlines() if line.startswith("NEEDRESTART-SVC:"))


def check_guest_ssh(address):
    """Verify the guest's configured listener from PVE, outside the guest network stack."""
    with socket.create_connection((address["host"], address["port"]), timeout=5) as connection:
        with connection.makefile("rb") as stream:
            for _ in range(8):
                line = stream.readline(256)
                if line.startswith(b"SSH-2.0-") or line.startswith(b"SSH-1.99-"):
                    return
                if not line or not line.endswith(b"\n"):
                    break
    raise RuntimeError("Guest SSH listener did not recover")


def recovered(request):
    recipe, expected = request["target"], request["expected"]
    vmid, service = recipe["proxmox"]["vmid"], recipe.get("service")
    boot, invocation = identity(vmid, service)
    if service == "systemd-manager":
        changed = boot == expected["bootId"] and not pending(vmid, service)
    elif service:
        changed = boot == expected["bootId"] and invocation and invocation != expected["invocationId"]
    else:
        changed = boot != expected["bootId"]
    if not changed:
        return False
    guest(vmid, recipe["health"])
    if request.get("guestSsh"):
        check_guest_ssh(request["guestSsh"])
    return True


def execute_accepted(directory):
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
            if service and service != "systemd-manager" and guest(vmid, ["/usr/bin/systemctl", "show", "-p", "Id", "--value", "--", service]) in ("dbus.service", "dbus-broker.service"):
                raise RuntimeError("The system bus requires a qualified client recovery recipe")
            if recipe.get("preflight"):
                guest(vmid, recipe["preflight"])
            ssh_check = ["/usr/sbin/sshd", "-t"]
            if recipe.get("reportedOn") and service in ("ssh.service", "sshd.service") and recipe.get("preflight") != ssh_check:
                guest(vmid, ssh_check)
            if (recipe.get("reportedOn") or request.get("requiredOnly")) and not pending(vmid, service):
                raise RuntimeError("The restart is no longer required")
            if recipe.get("reportedOn") and service != "systemd-manager":
                output = guest(vmid, ["/usr/bin/systemctl", "show", "--all",
                                     "-p", "ActiveState,SubState,CanStart,CanStop,RefuseManualStart,RefuseManualStop,Type,MainPID,InvocationID",
                                     "--", service])
                properties = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
                if not (properties.get("ActiveState") == "active" and properties.get("SubState") == "running"
                        and properties.get("CanStart") == properties.get("CanStop") == "yes"
                        and properties.get("RefuseManualStart") == properties.get("RefuseManualStop") == "no"
                        and properties.get("Type") != "oneshot" and int(properties.get("MainPID", "0")) > 0
                        and properties.get("InvocationID") == expected["invocationId"]):
                    raise RuntimeError("Reported service is no longer restartable")
            if identity(vmid, service) != (expected["bootId"], expected["invocationId"]):
                raise RuntimeError("Guest identity changed during preflight")
            if time.time() >= request["expires"]:
                raise RuntimeError("Confirmation expired")
            receipt(directory, "verifying")
            sent = True
            try:
                if recipe.get("reportedOn") and service == "systemd-manager":
                    guest(vmid, ["/usr/bin/systemctl", "daemon-reexec"], 90)
                elif service:
                    guest(vmid, ["/usr/bin/systemctl", "try-restart", "--", service], 120)
                else:
                    subprocess.run([QM, "reboot", str(vmid), "--timeout", "90"], check=True, timeout=105)
            except (OSError, RuntimeError, subprocess.SubprocessError):
                pass  # Only a fresh identity and a passing health probe can confirm the outcome.
            deadline = time.monotonic() + 420
            while time.monotonic() < deadline:
                try:
                    if recovered(request):
                        receipt(directory, "verified")
                        return
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                    pass
                time.sleep(4)
            receipt(directory, "unverified")
    except Exception:
        if not sent:
            receipt(directory, "refused")


def receipt_state(directory):
    path = directory / "receipt.json"
    return json.loads(path.read_text())["state"] if path.exists() else "missing"


def execute(directory):
    with (directory / "operation.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if receipt_state(directory) == "accepted":
            execute_accepted(directory)


def read(directory):
    """Resume observation only if the independent verifier has exited after dispatch."""
    state = receipt_state(directory)
    if state != "verifying":
        return state
    with (directory / "operation.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return state
        state = receipt_state(directory)
        if state == "verifying":
            try:
                if recovered(json.loads((directory / "request.json").read_text())):
                    receipt(directory, "verified")
                    return "verified"
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                pass
    return state


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
            (directory / "request.json").write_text(json.dumps({
                **{key:request[key] for key in ("target","expected","expires")},
                "guestSsh": request.get("guestSsh"),
                "requiredOnly": request.get("requiredOnly") is True}))
            runner = directory / "runner.py"
            runner.write_text(request["program"])
            receipt(directory, "accepted")
            subprocess.run(["/usr/bin/systemd-run", "--quiet", "--collect", "--property=RuntimeMaxSec=610",
                            "--unit=homelab-restart-" + identifier, "/usr/bin/python3", str(runner), "execute", identifier],
                           check=True, timeout=10)
    print(json.dumps({"state": read(directory)}))


if __name__ == "__main__":
    main()
