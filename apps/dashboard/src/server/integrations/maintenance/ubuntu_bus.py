"""Additional checks for the Homelab Ubuntu Main profile, composed with system_bus.py."""
import fcntl
import ipaddress


# Recover only previously connected clients of these installed units. Order matters:
# network and name resolution precede their consumers, PolicyKit precedes ModemManager.
MAIN_BUS_UNITS = {
    "systemd-networkd.service": "org.freedesktop.network1",
    "systemd-resolved.service": "org.freedesktop.resolve1",
    "polkit.service": "org.freedesktop.PolicyKit1",
    "ModemManager.service": "org.freedesktop.ModemManager1",
    "udisks2.service": "org.freedesktop.UDisks2",
    "upower.service": "org.freedesktop.UPower",
    "networkd-dispatcher.service": None,
    "snapd.service": None,
    "unattended-upgrades.service": None,
}
MAIN_DELAYS = {
    "ModemManager.service": ("sleep", "ModemManager"),
    "upower.service": ("sleep", "UPower"),
    "unattended-upgrades.service": ("shutdown", "Unattended Upgrades Shutdown"),
}
MAIN_NETWORK = {"systemd-networkd.service", "systemd-resolved.service"}


def main_network():
    """Verify the same routed uplink and a DNS response from the upstream resolver."""
    try:
        routes = json.loads(bus_cmd(["/usr/sbin/ip", "-j", "-4", "route", "show", "default"]))
        if len(routes) != 1 or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", routes[0]["dev"]):
            raise ValueError("Ambiguous uplink")
        device, gateway = routes[0]["dev"], str(ipaddress.IPv4Address(routes[0]["gateway"]))
        link = json.loads(bus_cmd(["/usr/bin/networkctl", "status", "--json=short", "--", device]))
        if link.get("Name") != device or link.get("OperationalState") != "routable":
            raise ValueError("Uplink is not routable")
        bus_cmd(["/usr/bin/ping", "-n", "-I", device, "-c1", "-W2", gateway], timeout=4)
        answer = bus_cmd(["/usr/bin/resolvectl", "query", "--cache=no", "--synthesize=no", "--zone=no",
                          "--search=no", "--protocol=dns", "--type=A", "--legend=no", "dashboard.home.rajohan.no."], timeout=5)
        if not any(re.match(r"^dashboard\.home\.rajohan\.no\.?\s+IN\s+A\s+", line) for line in answer.splitlines()):
            raise ValueError("No address answer")
        return [device, gateway]
    except (IndexError, KeyError, ValueError, OSError, subprocess.SubprocessError) as error:
        raise BusUnavailable("network") from error


def main_docker():
    # Docker must stay up with its workloads throughout recovery. This profile has
    # no firewalld (or Swarm) requiring Docker's anonymous bus event subscription.
    try:
        daemon = bus_fields("docker.service", "ActiveState", "InvocationID")
        if daemon["ActiveState"] != "active" or not re.fullmatch(r"[0-9a-f]{32}", daemon["InvocationID"]):
            raise ValueError("Docker unavailable")
        if bus_fields("firewalld.service", "LoadState")["LoadState"] != "not-found":
            raise ValueError("Firewall integration present")
        if bus_cmd(["/usr/bin/docker", "info", "--format", "{{.LiveRestoreEnabled}} {{.Swarm.LocalNodeState}}"]) != "true inactive":
            raise ValueError("Unsupported Docker profile")
        return daemon["InvocationID"]
    except (KeyError, ValueError, OSError, subprocess.SubprocessError) as error:
        raise BusUnavailable("workloads") from error


def main_inhibitors(pids):
    result = bus_cmd(["/usr/bin/busctl", "--system", "--timeout=3", "--json=short", "--auto-start=no", "call",
                      "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "ListInhibitors"])
    rows, = json.loads(result)["data"]
    held = set()
    for what, who, _, mode, uid, pid in rows:
        unit = pids.get(pid)
        if uid != 0 or mode != "delay" or MAIN_DELAYS.get(unit) != (what, who):
            raise BusUnavailable("inhibitors")
        held.add(unit)
    return held


def main_clients(rows, strict):
    """Bind each reviewed unit's anonymous/owned names to its actual MainPID."""
    units = {r.get("unit") for r in rows} & (MAIN_BUS_UNITS.keys() | {"docker.service"})
    pids = {int(bus_fields(unit, "MainPID")["MainPID"]): unit for unit in units}
    remaining, connected, owners = [], set(), set()
    for row in rows:
        unit, name = row.get("unit"), row["name"]
        if unit not in units:
            remaining.append(row)
            continue
        if pids.get(row["pid"]) != unit or not (name.startswith(":") or name == MAIN_BUS_UNITS.get(unit)):
            if strict:
                raise BusUnavailable("clients")
            continue
        if name.startswith(":"):
            connected.add(unit)
        else:
            owners.add(unit)
    ready = {unit for unit in connected if not MAIN_BUS_UNITS.get(unit) or unit in owners}
    if strict and (ready != units or not MAIN_NETWORK <= ready):
        raise BusUnavailable("clients")
    return remaining, ready, pids


def main_baseline(connected, pids):
    # Do not interrupt an unrelated installer or a client with unaudited stop dependencies.
    for path in ["/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock"]:
        try:
            with open(path, "r+") as lock:
                fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise BusUnavailable("workloads") from error
    for unit in connected - {"docker.service"}:
        flags = bus_fields(unit, "RefuseManualStart", "RefuseManualStop", "RequiredBy", "BoundBy", "ConsistsOf", "PropagatesStopTo")
        allowed = ({"ModemManager.service"} if unit == "polkit.service" else
                   {"systemd-networkd-wait-online.service", "systemd-networkd-persistent-storage.service"} if unit == "systemd-networkd.service" else set())
        affected = set(" ".join(flags[k] for k in ("RequiredBy", "BoundBy", "ConsistsOf", "PropagatesStopTo")).split())
        if affected - allowed or flags["RefuseManualStop"] != "no" or flags["RefuseManualStart"] != "no":
            raise BusUnavailable("unit-policy")
    return {"clients": sorted(connected - {"docker.service"}), "inhibitors": sorted(main_inhibitors(pids)),
            "docker": main_docker(), "uplink": main_network()}


def main_restore_clients(snapshot):
    """Recover a disconnected service at most once, even across verification retries."""
    deadline = time.monotonic() + 65
    attempted = set()
    time.sleep(3)
    while time.monotonic() < deadline:
        try:
            _, ready, pids = main_clients(bus_connections(), False)
            missing = set(snapshot["clients"]) - ready
            if not missing:
                missing = set(snapshot["inhibitors"]) - main_inhibitors(pids)
        except (KeyError, OSError, ValueError, subprocess.SubprocessError, BusUnavailable):
            time.sleep(1)
            continue
        if not missing:
            return
        for unit in MAIN_BUS_UNITS:
            if unit in missing and unit not in attempted:
                if bus_fields(unit, "ActiveState").get("ActiveState") in {"activating", "deactivating", "reloading"}:
                    continue
                attempted.add(unit)
                # The service may have exited on bus disconnect. Restart also starts
                # it in that case, and is restricted to this preflight's active set.
                bus_cmd(["/usr/bin/systemctl", "--no-block", "restart", "--", unit])
                break
        time.sleep(1)
    raise RuntimeError("Expected system bus clients or inhibitors did not return")


def main_verified(snapshot, rows):
    _, ready, pids = main_clients(rows, False)
    return (set(snapshot["clients"]) <= ready and set(snapshot["inhibitors"]) <= main_inhibitors(pids)
            and main_network() == snapshot["uplink"] and main_docker() == snapshot["docker"])
