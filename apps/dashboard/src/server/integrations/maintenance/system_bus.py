"""Qualified recovery of the classic Debian system bus on a headless systemd host."""
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import time
import uuid


BUS_ROOT = Path("/run/homelab-dashboard/system-bus")
BUS_UNIT = "dbus.service"
LOGIN_UNIT = "systemd-logind.service"
BUS_NAMES = {"org.freedesktop.DBus", "org.freedesktop.systemd1", "org.freedesktop.login1"}
BUS_ENV = {"LC_ALL": "C", "PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "HOME": "/nonexistent"}


class BusUnavailable(Exception):
    """A fixed, public preflight result. Raw command output never leaves the host."""


def bus_cmd(argv, timeout=5):
    result = subprocess.run(argv, timeout=timeout, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=BUS_ENV, check=True)
    if len(result.stdout) > 256 * 1024:
        raise RuntimeError("System bus response exceeds its budget")
    return result.stdout.decode().strip()


def bus_fields(unit, *properties):
    result = bus_cmd(["/usr/bin/systemctl", "show", "--all", "--property=" + ",".join(properties), "--", unit])
    return dict(row.split("=", 1) for row in result.splitlines() if "=" in row)


def bus_id():
    result = bus_cmd(["/usr/bin/busctl", "--system", "--timeout=3", "call", "org.freedesktop.DBus",
                      "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetId"])
    match = re.fullmatch(r's "([a-f0-9]{32})"', result)
    if not match:
        raise BusUnavailable("unavailable")
    return match[1]


def bus_executable(pid, path):
    # Debian may have just replaced the running executable as part of the pending update.
    return os.readlink("/proc/" + str(pid) + "/exe").removesuffix(" (deleted)") == path


def bus_connections():
    # This one list contains well-known owners and anonymous connections. Ignore only our own busctl PID.
    with subprocess.Popen(["/usr/bin/busctl", "--system", "--timeout=3", "--json=short", "list"],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=BUS_ENV) as child:
        try:
            output = child.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate()
            raise
        if child.returncode or len(output) > 256 * 1024:
            raise BusUnavailable("unavailable")
        return [row for row in json.loads(output) if row.get("pid") is not None and row["pid"] != child.pid]


def bus_endpoints(rows, operator_uid, login_pid, strict=True):
    owners = set()
    users = {}
    for row in rows:
        name, pid, unit = row["name"], row["pid"], row.get("unit")
        if not name.startswith(":"):
            if strict and name not in BUS_NAMES:
                raise BusUnavailable("clients")
            if name == "org.freedesktop.systemd1" and pid != 1 or name == "org.freedesktop.login1" and pid != login_pid:
                raise BusUnavailable("login")
            owners.add(name)
            continue
        if (pid == 1 and unit == "init.scope") or (pid == login_pid and unit == LOGIN_UNIT):
            continue
        if unit == "user@" + str(operator_uid) + ".service" and row.get("process") == "systemd" and operator_uid < 1000:
            users[unit] = pid
        elif strict:
            raise BusUnavailable("clients")
    return owners, users


def bus_login():
    bus_cmd(["/usr/bin/busctl", "--system", "--timeout=3", "--auto-start=no", "call",
             "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "ListSessions"])


def bus_preflight(operator_uid):
    release = platform.freedesktop_os_release()
    if (release.get("ID") != "debian" or release.get("VERSION_ID") != "13" or os.geteuid() != 0
            or not os.access("/usr/bin/systemd-run", os.X_OK)):
        raise BusUnavailable("implementation")
    if not re.match(r"systemd 257\b", bus_cmd(["/usr/bin/systemctl", "--version"])) or not re.search(
            r"\b1\.16\.", bus_cmd(["/usr/bin/dbus-daemon", "--version"])):
        raise BusUnavailable("implementation")
    props = bus_fields(BUS_UNIT, "Id", "ActiveState", "InvocationID", "MainPID", "RequiredBy", "BoundBy",
                       "ConsistsOf", "PropagatesStopTo", "RefuseManualStart", "RefuseManualStop")
    if (props.get("Id") != BUS_UNIT or props.get("ActiveState") != "active" or not re.fullmatch(r"[0-9a-f]{32}", props.get("InvocationID",""))
            or not bus_executable(props["MainPID"], "/usr/bin/dbus-daemon")):
        raise BusUnavailable("implementation")
    if any(props.get(k) != "" for k in ("RequiredBy", "BoundBy", "ConsistsOf", "PropagatesStopTo")) or any(
            props.get(k) != "no" for k in ("RefuseManualStart","RefuseManualStop")):
        raise BusUnavailable("unit-policy")
    login = bus_fields(LOGIN_UNIT, "ActiveState", "MainPID", "InvocationID", "RefuseManualStop", "RefuseManualStart")
    if login.get("ActiveState") != "active" or login.get("RefuseManualStop") != "no" or login.get("RefuseManualStart") != "no":
        raise BusUnavailable("login")
    owners, users = bus_endpoints(bus_connections(), operator_uid, int(login["MainPID"]))
    if owners != BUS_NAMES:
        raise BusUnavailable("login")
    # A previously disconnected Type=dbus service would be invisible in ListNames.
    active = bus_cmd(["/usr/bin/systemctl", "list-units", "--no-legend", "--no-pager", "--plain", "--state=active", "--type=service"])
    units = [row.split()[0] for row in active.splitlines() if row.strip()]
    if not units or len(units) > 1024:
        raise BusUnavailable("unavailable")
    for start in range(0, len(units), 64):
        names = bus_cmd(["/usr/bin/systemctl", "show", "-p", "BusName", "--value", "--", *units[start:start + 64]])
        if any(n and n not in BUS_NAMES for n in names.splitlines()):
            raise BusUnavailable("clients")
    for unit, pid in users.items():
        if pid <= 1 or bus_fields(unit,"MainPID").get("MainPID") != str(pid) or not bus_executable(pid,"/usr/lib/systemd/systemd"):
            raise BusUnavailable("clients")
    inhibitors = bus_cmd(["/usr/bin/busctl", "--system", "--timeout=3", "--auto-start=no", "call",
                          "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "ListInhibitors"])
    if inhibitors != "a(ssssuu) 0":
        raise BusUnavailable("inhibitors")
    sessions = json.loads(bus_cmd(["/usr/bin/loginctl", "--json=short", "list-sessions"]))
    if not isinstance(sessions,list) or any(row.get("uid") != operator_uid or row.get("tty") for row in sessions):
        raise BusUnavailable("sessions")
    bus_login()
    return {"bus": bus_id(), "invocation": props["InvocationID"], "login": login["InvocationID"], "users": users}


def bus_login_uid():
    return int(Path("/proc/self/loginuid").read_text().strip())


def bus_eligibility():
    try:
        bus_preflight(bus_login_uid())
        return "qualified"
    except BusUnavailable as error:
        return str(error)
    except (KeyError, OSError, ValueError, subprocess.SubprocessError, RuntimeError):
        return "unavailable"


def bus_write(path, value):
    temp = path.with_suffix(".tmp")
    with temp.open("w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def bus_directory(operation):
    return BUS_ROOT / str(uuid.UUID(operation))


def bus_active_users(snapshot):
    return {unit:pid for unit,pid in snapshot["users"].items() if bus_fields(unit,"ActiveState","MainPID").get("MainPID") == str(pid)}


def bus_restored(snapshot, uid):
    if bus_id() == snapshot["bus"]:
        return False
    login = bus_fields(LOGIN_UNIT, "MainPID")
    owners, users = bus_endpoints(bus_connections(), uid, int(login["MainPID"]), strict=False)
    if not BUS_NAMES.issubset(owners) or any(users.get(unit) != pid for unit, pid in snapshot["users"].items()):
        return False
    bus_login()
    return True


def bus_recover(snapshot, uid):
    # Reconnect PID 1 using its documented signal only if its well-known name did not recover.
    rows = bus_connections()
    names = {row["name"] for row in rows}
    if "org.freedesktop.systemd1" not in names:
        os.kill(1, signal.SIGUSR1)
    login = bus_fields(LOGIN_UNIT, "InvocationID", "MainPID")
    if "org.freedesktop.login1" not in names and login.get("InvocationID") == snapshot["login"]:
        bus_cmd(["/usr/bin/systemctl", "try-restart", "--", LOGIN_UNIT], timeout=25)
    # A disconnected automation-account manager can re-exec in place. Keep its original PID and its units.
    _, connected = bus_endpoints(bus_connections(), uid, int(bus_fields(LOGIN_UNIT,"MainPID")["MainPID"]), strict=False)
    for unit, pid in bus_active_users(snapshot).items():
        if connected.get(unit) == pid:
            continue
        fd = os.pidfd_open(pid)
        try:
            if bus_fields(unit, "MainPID").get("MainPID") != str(pid) or not bus_executable(pid,"/usr/lib/systemd/systemd"):
                raise RuntimeError("User manager changed")
            signal.pidfd_send_signal(fd, signal.SIGRTMIN + 25)
        finally:
            os.close(fd)


def bus_execute(directory):
    import fcntl
    with (BUS_ROOT / "recovery.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if json.loads((directory / "receipt").read_text()) != "accepted":
            return
        request = json.loads((directory / "request").read_text())
        expected, uid = request["expected"], request["uid"]
        sent = False
        try:
            if request.get("preflight"):
                bus_cmd(request["preflight"], timeout=10)
            report = read_service_report(bus_cmd)
            if not any(s["unit"] == BUS_UNIT and s["restartable"] and s["invocationId"] == expected["invocationId"] for s in report["services"]):
                raise BusUnavailable("requirement")
            snapshot = bus_preflight(uid)
            if (snapshot["invocation"] != expected["invocationId"] or
                    Path("/proc/sys/kernel/random/boot_id").read_text().strip() != expected["bootId"] or time.time() > request["expires"]):
                raise BusUnavailable("identity")
            bus_write(directory / "baseline", snapshot)
            bus_write(directory / "receipt", "verifying")
            sent = True
            try:
                bus_cmd(["/usr/bin/systemctl", "try-restart", "--", BUS_UNIT], timeout=30)
            except (OSError, subprocess.SubprocessError):
                pass
            until = time.monotonic() + 20
            while time.monotonic() < until:
                try:
                    if bus_id() != snapshot["bus"] and bus_fields(BUS_UNIT,"InvocationID")["InvocationID"] != expected["invocationId"]:
                        break
                except (OSError, subprocess.SubprocessError, BusUnavailable):
                    pass
                time.sleep(0.5)
            else:
                raise RuntimeError("New system bus not confirmed")
            bus_recover(snapshot, uid)
            until = time.monotonic() + 25
            while time.monotonic() < until:
                try:
                    if bus_restored(snapshot, uid):
                        confirmed = {"bus":bus_id(), "invocation":bus_fields(BUS_UNIT, "InvocationID")["InvocationID"]}
                        if confirmed["bus"] == snapshot["bus"] or confirmed["invocation"] == expected["invocationId"]:
                            break
                        bus_cmd(request["health"], timeout=10)
                        bus_write(directory / "confirmed", confirmed)
                        bus_write(directory / "receipt", "verified")
                        return
                except (OSError, ValueError, subprocess.SubprocessError, BusUnavailable):
                    pass
                time.sleep(0.5)
            raise RuntimeError("Client recovery not confirmed")
        except Exception as error:
            if not sent:
                bus_write(directory / "refusal", str(error) if isinstance(error, BusUnavailable) else "preflight")
            bus_write(directory / "receipt", "unverified" if sent else "refused")


def bus_submit(request):
    directory = bus_directory(request["operationId"])
    BUS_ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        return
    uid = bus_login_uid()
    target = request["target"]
    bus_write(directory / "request", {"expected": request["expected"], "uid": uid, "expires":time.time()+45,
                                     "health": target["health"], "preflight":target.get("preflight")})
    runner = directory / "runner.py"
    runner.write_text(request["busProgram"])
    bus_write(directory / "receipt", "accepted")
    bus_cmd(["/usr/bin/systemd-run", "--quiet", "--collect", "--property=RuntimeMaxSec=180",
             "--unit=homelab-bus-" + directory.name, "/usr/bin/python3", str(runner), "--execute-bus", directory.name], timeout=10)


def bus_status(operation, expected):
    directory = bus_directory(operation)
    if not (directory / "receipt").is_file():
        return "missing"
    request = json.loads((directory / "request").read_text())
    if request["expected"]["invocationId"] != expected["invocationId"] or request["expected"]["bootId"] != expected["bootId"]:
        return "unverified"
    state = json.loads((directory / "receipt").read_text())
    if state == "verified":
        confirmed = json.loads((directory / "confirmed").read_text())
        if (Path("/proc/sys/kernel/random/boot_id").read_text().strip() != expected["bootId"] or
                bus_id() != confirmed["bus"] or bus_fields(BUS_UNIT, "InvocationID").get("InvocationID") != confirmed["invocation"] or
                not bus_restored(json.loads((directory/"baseline").read_text()), request["uid"])):
            return "unverified"
    return state


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--execute-bus":
    bus_execute(bus_directory(sys.argv[2]))
