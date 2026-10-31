"""Finite, journaled Homelab replacement owned by systemd rather than the replaced worker.

Only the worker sends this protocol over its existing pinned SSH connection. Recipes
are operator configuration, not browser input. Command output and secret-bearing
Compose data never enter the receipt. The same source is staged once per operation.
"""
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import parse_qsl, unquote, urlsplit


class Refusal(RuntimeError):
    """Expose a fixed failure code instead of private subprocess output."""


def digest(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def canonical(value, directory=False, private=False):
    path = Path(value)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise Refusal("path_changed")
    metadata = path.lstat()
    if (not stat.S_ISDIR(metadata.st_mode) if directory else not stat.S_ISREG(metadata.st_mode)):
        raise Refusal("path_changed")
    if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise Refusal("path_permissions")
    if private and stat.S_IMODE(metadata.st_mode) != (0o700 if directory else 0o600):
        raise Refusal("path_permissions")
    return path


def read_file(path, limit=2_000_000):
    canonical(str(path))
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise Refusal("file_limit")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            value = stream.read(limit + 1)
        if len(value) > limit:
            raise Refusal("file_limit")
        return value
    finally:
        os.close(descriptor)


def replace_file(path, value, expected=None):
    """Preserve the source owner/mode/ACL and refuse replacement after any source change."""
    parent = canonical(str(path.parent), directory=True)
    if expected is not None:
        if read_file(path) != expected:
            raise Refusal("configuration_changed")
        metadata = path.stat()
        attributes = {name: os.getxattr(path, name, follow_symlinks=False)
                      for name in os.listxattr(path, follow_symlinks=False)}
        if metadata.st_mode & 0o7000 or set(attributes) - {"system.posix_acl_access"}:
            raise Refusal("path_permissions")
        mode, owner, group = stat.S_IMODE(metadata.st_mode), metadata.st_uid, metadata.st_gid
    else:
        if path.exists() or path.is_symlink():
            raise Refusal("operation_exists")
        mode, owner, group, attributes = 0o600, os.geteuid(), os.getegid(), {}
    descriptor, temporary = tempfile.mkstemp(prefix=".release-", dir=parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fchown(stream.fileno(), owner, group)
            os.fchmod(stream.fileno(), mode)
            for name in os.listxattr(stream.fileno()):
                if name not in attributes:
                    os.removexattr(stream.fileno(), name)
            for name, attribute in attributes.items():
                os.setxattr(stream.fileno(), name, attribute)
            os.fsync(stream.fileno())
        if expected is not None and read_file(path) != expected:
            raise Refusal("configuration_changed")
        os.replace(temporary, path)
        parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def command(arguments, directory, timeout=60, output_file=None):
    """Run a fixed argv, bound output/deadline, and reap its process group on every exit."""
    if not arguments or not arguments[0].startswith("/") or any("\0" in item for item in arguments):
        raise Refusal("command_invalid")
    environment = {name: value for name, value in os.environ.items()
                   if name in {"HOME", "DOCKER_CONFIG", "DOPPLER_TOKEN", "DOPPLER_CONFIG_DIR"}}
    environment.update(PATH="/usr/local/bin:/usr/bin:/bin", LC_ALL="C")
    child = subprocess.Popen(arguments, cwd=directory, env=environment, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    deadline, output, error_size, total = time.monotonic() + timeout, bytearray(), 0, 0
    completed = False
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            selector.register(child.stderr, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise Refusal("command_timeout")
                for key, _ in selector.select(0.1):
                    data = os.read(key.fd, 65536)
                    if not data:
                        selector.unregister(key.fd)
                    elif key.fileobj is child.stderr:
                        error_size += len(data)
                        if error_size > 2_000_000:
                            raise Refusal("command_output_limit")
                    else:
                        total += len(data)
                        if total > (512 * 1024 * 1024 if output_file else 2_000_000):
                            raise Refusal("command_output_limit")
                        if output_file:
                            output_file.write(data)
                        else:
                            output.extend(data)
        if child.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
            raise Refusal("command_failed")
        completed = True
        return bytes(output)
    finally:
        if not completed or child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            # The leader may already have exited while a descendant kept a pipe open.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.stdout.close()
        child.stderr.close()


@contextmanager
def directory_lock(path, wait=0):
    descriptor = os.open(canonical(str(path), directory=True), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as error:
                if time.monotonic() >= deadline:
                    raise Refusal("host_busy") from error
                time.sleep(0.1)
        yield
    finally:
        os.close(descriptor)


def compose(target, arguments):
    return command(target["composeCommand"] + ["--project-name", target["project"], *arguments], target["directory"])


def configured(target):
    value = json.loads(compose(target, ["config", "--format", "json"]))
    if value.get("name") != target["project"]:
        raise Refusal("project_changed")
    return value


def container(target, service):
    identities = command(["/usr/bin/docker", "ps", "--all", "--quiet", "--no-trunc",
                          "--filter", "label=com.docker.compose.project=" + target["project"],
                          "--filter", "label=com.docker.compose.service=" + service], target["directory"]).decode().splitlines()
    if len(identities) != 1 or not re.fullmatch("[a-f0-9]{64}", identities[0]):
        raise Refusal("container_changed")
    data = json.loads(command(["/usr/bin/docker", "inspect", identities[0]], target["directory"]))[0]
    for mount in data.get("Mounts", []):
        path = os.path.normpath(mount["Destination"])
        if re.search(r"\.(?:py|pyc|js|mjs|cjs|jsx|ts|tsx|so|node)$", path, re.I) or re.match(r"^/app(?:$|/(?:src|lib|dist|node_modules)(?:/|$))", path):
            raise Refusal("local_code_override")
    labels = data["Config"].get("Labels", {})
    if labels.get("com.docker.compose.project") != target["project"] or labels.get("com.docker.compose.service") != service:
        raise Refusal("container_changed")
    image = json.loads(command(["/usr/bin/docker", "image", "inspect", data["Image"]], target["directory"]))[0]
    image_labels = image.get("Config", {}).get("Labels") or {}
    schema = image_labels.get("io.homelab.dashboard-schema", "")
    auth_schema = image_labels.get("io.homelab.auth-schema", "")
    return {"authSchema": auth_schema if isinstance(auth_schema, str) and re.fullmatch("[a-f0-9]{64}", auth_schema) else None,
            "dashboardSchema": schema if isinstance(schema, str) and re.fullmatch("[a-f0-9]{64}", schema) else None, "id": data["Id"], "imageId": data["Image"], "image": data["Config"]["Image"],
            "running": data["State"]["Running"], "health": data["State"].get("Health", {}).get("Status")}


def unit_state(target, unit):
    raw = command(["/usr/bin/systemctl", "show", unit, "--property=ActiveState,InvocationID"], target["directory"]).decode()
    fields = dict(line.split("=", 1) for line in raw.splitlines() if "=" in line)
    return {"active": fields.get("ActiveState"), "invocation": fields.get("InvocationID")}


def browser_bindings(target, configuration, observed):
    """Bind each saved network slot to exactly one explicitly managed proxy service."""
    if not isinstance(configuration, dict) or not isinstance(configuration.get("imageId"), str) or not re.fullmatch("sha256:[a-f0-9]{64}", configuration["imageId"]):
        raise Refusal("browser_configuration")
    slots = configuration.get("networks", [])
    if not isinstance(slots, list) or len(slots) > 2 or ("networks" in configuration and not slots):
        raise Refusal("browser_configuration")
    if not slots:
        if target.get("browserProxyUnits"):
            raise Refusal("browser_proxy_units")
        return []
    units = target.get("browserProxyUnits", [])
    if not units or len(set(units)) != len(units) or not set(units) < set(target["units"]):
        raise Refusal("browser_proxy_units")
    proxies = [service for service in target["services"] if service["app"] == "mira-browser-proxy"]
    if len(proxies) != len(slots):
        raise Refusal("browser_proxy_mapping")
    result = []
    for slot in slots:
        if not isinstance(slot, dict) or set(slot) != {"networkId", "proxyId", "proxyImageId"} or not all(
                isinstance(slot[key], str) and re.fullmatch(pattern, slot[key]) for key, pattern in
                [("networkId", "[a-f0-9]{64}"), ("proxyId", "[a-f0-9]{64}"), ("proxyImageId", "sha256:[a-f0-9]{64}")]):
            raise Refusal("browser_configuration")
        matches = [service["name"] for service in proxies if observed[service["name"]]["id"] == slot["proxyId"] and
                   observed[service["name"]]["imageId"] == slot["proxyImageId"]]
        if len(matches) != 1:
            raise Refusal("browser_proxy_mapping")
        result.append({"service": matches[0], "networkId": slot["networkId"]})
    if len({item["service"] for item in result}) != len(result) or len({item["networkId"] for item in result}) != len(result):
        raise Refusal("browser_proxy_mapping")
    return result


def browser_slots(target, bindings, observed):
    """Keep the approved network identities and verify their sole healthy managed peers."""
    slots = []
    for binding in bindings:
        proxy = observed[binding["service"]]
        network = json.loads(command(["/usr/bin/docker", "network", "inspect", binding["networkId"]], target["directory"]))[0]
        data = json.loads(command(["/usr/bin/docker", "inspect", proxy["id"]], target["directory"]))[0]
        endpoints = list(data.get("NetworkSettings", {}).get("Networks", {}).values())
        slot = next((endpoint for endpoint in endpoints if endpoint.get("NetworkID") == binding["networkId"]), {})
        if (network.get("Id") != binding["networkId"] or network.get("Driver") != "bridge" or
                network.get("Internal") is not True or network.get("EnableIPv6") is not False or
                network.get("Options", {}).get("com.docker.network.bridge.gateway_mode_ipv4") != "isolated" or
                set(network.get("Containers", {})) != {proxy["id"]} or data.get("Id") != proxy["id"] or
                data.get("Image") != proxy["imageId"] or data.get("State", {}).get("Running") is not True or
                data.get("State", {}).get("Health", {}).get("Status") != "healthy" or len(endpoints) != 2 or
                "mira-egress" not in (slot.get("Aliases") or []) or
                (slot.get("DriverOpts") or {}).get("com.docker.network.endpoint.ifname") != "browser"):
            raise Refusal("browser_proxy_verification")
        slots.append({"networkId": binding["networkId"], "proxyId": proxy["id"], "proxyImageId": proxy["imageId"]})
    return slots


def verify_browser_recovery(target, directory, before, observed):
    """Accept only the original browser configuration plus verified replacement proxy IDs."""
    if not target.get("browserConfigFile"):
        return
    current = read_file(Path(target["browserConfigFile"]))
    backup = directory / "browser.before"
    source = read_file(backup) if backup.exists() else current
    if digest(source) != before["browserHash"]:
        raise Refusal("configuration_changed")
    original = json.loads(source)
    bindings = browser_bindings(target, original, before["containers"])
    if bindings:
        original["networks"] = browser_slots(target, bindings, observed)
        if json.loads(current) != original:
            raise Refusal("configuration_changed")
    elif digest(current) != before["browserHash"]:
        raise Refusal("configuration_changed")


def release_images(release):
    repository, version, revision = release["repository"].lower(), release["version"], release["revision"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,99}/[a-z0-9][a-z0-9_.-]{0,99}", repository) or not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch("[a-f0-9]{40}", revision):
        raise Refusal("release_invalid")
    if any(key in release and not re.fullmatch("[a-f0-9]{64}", release[key]) for key in ["dashboardSchema", "authSchema"]):
        raise Refusal("release_invalid")
    images = {}
    for image in release["images"]:
        app, reference = image["app"], image["reference"]
        prefix = "ghcr.io/" + repository + "/" + app + ":" + version + "@sha256:"
        if app not in {"auth", "dashboard", "mira", "mira-browser", "mira-browser-proxy"} or app in images or not reference.startswith(prefix) or not re.fullmatch("[a-f0-9]{64}", reference[len(prefix):]):
            raise Refusal("release_invalid")
        images[app] = reference
    if "dashboard" not in images:
        raise Refusal("release_incomplete")
    return images


def inspect(target, release, allow_current=False, drained=False):
    """Observe only identities/hashes; never return expanded Compose environment or paths."""
    images = release_images(release)
    canonical(target["directory"], directory=True)
    canonical(target["stateDirectory"], directory=True, private=True)
    source = read_file(Path(target["composeFile"]))
    config = configured(target)
    observed = {}
    for service in target["services"]:
        name, app = service["name"], service["app"]
        if app not in images:
            raise Refusal("release_incomplete")
        current = container(target, name)
        if config.get("services", {}).get(name, {}).get("image") != current["image"] or not current["running"] or current["health"] != "healthy":
            raise Refusal("service_unavailable")
        prefix = "ghcr.io/" + release["repository"].lower() + "/" + app + ":"
        match = re.fullmatch(re.escape(prefix) + r"(\d+)\.(\d+)\.(\d+)@sha256:[a-f0-9]{64}", current["image"])
        if not match or (not allow_current and tuple(map(int, match.groups())) >= tuple(map(int, release["version"].split(".")))):
            raise Refusal("release_not_newer")
        observed[name] = current
    units = {unit: unit_state(target, unit) for unit in target["units"]}
    if any(value["active"] != "active" or not re.fullmatch("[a-f0-9]{32}", value["invocation"] or "") for value in units.values()):
        raise Refusal("service_unavailable")
    browser_hash = None
    if target.get("browserConfigFile"):
        if "mira-browser" not in images or "mira-browser-proxy" not in images:
            raise Refusal("release_incomplete")
        browser_source = read_file(Path(target["browserConfigFile"]))
        browser_hash = digest(browser_source)
        bindings = browser_bindings(target, json.loads(browser_source), observed)
        if drained:
            browser_slots(target, bindings, observed)
    return {"targetHash": digest(encoded(target)), "composeHash": digest(source), "configHash": digest(encoded(config)),
            "browserHash": browser_hash, "containers": observed, "units": units}


def operation_directory(target, identity):
    if str(uuid.UUID(identity)) != identity:
        raise Refusal("operation_invalid")
    root = canonical(target["stateDirectory"], directory=True, private=True)
    return root / identity


def save_status(directory, value):
    path = directory / "status.json"
    value["updatedAt"] = time.time()
    replace_file(path, encoded(value), read_file(path) if path.exists() else None)


def status(target, identity):
    directory = operation_directory(target, identity)
    if not directory.exists():
        return {"state": "absent", "id": identity}
    canonical(str(directory), directory=True, private=True)
    intent = json.loads(read_file(directory / "intent.json"))
    if intent["target"] != target or intent["id"] != identity:
        raise Refusal("operation_changed")
    result = json.loads(read_file(directory / "status.json"))
    if result["id"] != identity or result["requestHash"] != digest(encoded(intent)):
        raise Refusal("operation_changed")
    if result["state"] == "running":
        unit = "homelab-release-" + identity.replace("-", "") + ".service"
        if unit_state(target, unit)["active"] not in {"active", "activating", "deactivating"}:
            result = {**result, "state": "unknown", "code": "runner_interrupted"}
    return result


def submit(request, source):
    target, identity = request["target"], request["id"]
    directory = operation_directory(target, identity)
    intent = {key: request[key] for key in ["id", "target", "release", "expected"]}
    if directory.exists():
        if json.loads(read_file(directory / "intent.json")) != intent:
            raise Refusal("operation_changed")
        return status(target, identity)
    with directory_lock(Path(target["directory"])):
        if directory.exists():
            if json.loads(read_file(directory / "intent.json")) != intent:
                raise Refusal("operation_changed")
            return status(target, identity)
        if not time.time() < request["deadline"] <= time.time() + 90:
            raise Refusal("request_expired")
        if inspect(target, request["release"], drained=True) != request["expected"]:
            raise Refusal("confirmation_changed")
        if time.time() >= request["deadline"]:
            raise Refusal("request_expired")
        if shutil.disk_usage(target["stateDirectory"]).free < 1024 * 1024 * 1024:
            raise Refusal("backup_space")
        if len(list(Path(target["stateDirectory"]).iterdir())) >= 100:
            raise Refusal("history_limit")
        directory.mkdir(mode=0o700)
        replace_file(directory / "intent.json", encoded(intent))
        replace_file(directory / "runner.py", source.encode())
        save_status(directory, {"id": identity, "requestHash": digest(encoded(intent)), "state": "running",
                                "phase": "accepted", "changesStarted": False, "migrationStarted": False})
        args = ["/usr/bin/systemd-run", "--quiet", "--collect", "--service-type=exec",
                "--unit=homelab-release-" + identity.replace("-", "") + ".service",
                "--property=UMask=0077", "--property=RuntimeMaxSec=1800", "--property=TimeoutStopSec=15",
                "--property=KillMode=control-group", "--property=Restart=no",
                "--property=StandardOutput=null", "--property=StandardError=null"]
        if target.get("environmentFile"):
            canonical(target["environmentFile"], private=True)
            args.append("--property=EnvironmentFile=" + target["environmentFile"])
        args += ["/usr/bin/python3", "-I", "-B", str(directory / "runner.py"), "run", str(directory)]
        command(args, target["directory"], timeout=10)
    return status(target, identity)


def image_identity(target, reference, release):
    data = json.loads(command(["/usr/bin/docker", "image", "inspect", reference], target["directory"]))[0]
    labels = data.get("Config", {}).get("Labels", {}) or {}
    if (data.get("Architecture") != "amd64" or data.get("Os") != "linux" or
            not re.fullmatch("sha256:[a-f0-9]{64}", data.get("Id", "")) or
            labels.get("org.opencontainers.image.version") != release["version"] or
            labels.get("org.opencontainers.image.revision") != release["revision"] or
            labels.get("org.opencontainers.image.source", "").lower() != "https://github.com/" + release["repository"].lower()):
        raise Refusal("image_verification")
    if release.get("dashboardSchema") and reference in [image["reference"] for image in release["images"] if image["app"] in {"dashboard", "mira"}]:
        if labels.get("io.homelab.dashboard-schema") != release["dashboardSchema"]:
            raise Refusal("image_verification")
    if release.get("authSchema") and reference in [image["reference"] for image in release["images"] if image["app"] == "auth"]:
        if labels.get("io.homelab.auth-schema") != release["authSchema"]:
            raise Refusal("image_verification")
    return data["Id"]


def compose_replacement(source, config, target, images):
    """Replace literal image fields only, then require the complete rendered config to match."""
    replacements = {}
    expected = copy.deepcopy(config)
    for service in target["services"]:
        name = service["name"]
        before, after = config["services"][name]["image"], images[service["app"]]
        if before in replacements and replacements[before] != after:
            raise Refusal("configuration_ambiguous")
        replacements[before] = after
        expected["services"][name]["image"] = after
    text = source.decode("utf-8")
    for before, after in replacements.items():
        # Interpolated pins, aliases and image values embedded in other fields are unsupported.
        pattern = r"(?m)^(\s+image:\s*)([\"']?)" + re.escape(before) + r"\2(\s*(?:#.*)?)$"
        text, count = re.subn(pattern, lambda match: match[1] + match[2] + after + match[2] + match[3], text)
        required = sum(config["services"][service["name"]]["image"] == before for service in target["services"])
        if count != required:
            raise Refusal("configuration_ambiguous")
    return text.encode(), expected


def verify_services(target, references, identities, timeout=120):
    deadline = time.monotonic() + timeout
    while True:
        try:
            result = {service["name"]: container(target, service["name"]) for service in target["services"]}
            if all(value["running"] and value["health"] == "healthy" and
                   value["image"] == references[name] and value["imageId"] == identities[name]
                   for name, value in result.items()) and all(
                       unit_state(target, unit)["active"] == "active" for unit in target["units"]):
                return result
        except Refusal:
            pass
        if time.monotonic() >= deadline:
            raise Refusal("service_verification")
        time.sleep(1)


def start_browser_proxies(target, bindings, path, configuration, previous, references, identities):
    """Start only selected proxies and atomically bind their verified replacement identities."""
    proxy_target = {**target, "services": [service for service in target["services"] if service["app"] == "mira-browser-proxy"],
                    "units": target["browserProxyUnits"]}
    command(["/usr/bin/systemctl", "start", *proxy_target["units"]], target["directory"], timeout=120)
    proxies = verify_services(proxy_target,
        {service["name"]: references[service["name"]] for service in proxy_target["services"]},
        {service["name"]: identities[service["name"]] for service in proxy_target["services"]})
    if any(container(target, service["name"])["running"] for service in target["services"] if service["app"] != "mira-browser-proxy"):
        raise Refusal("browser_proxy_units")
    refreshed = {**configuration, "networks": browser_slots(target, bindings, proxies)}
    replacement = encoded(refreshed)
    replace_file(path, replacement, previous)
    return replacement, refreshed


def recipe(arguments, directory, images):
    values = {"{runner}": str(directory / "runner.py"), "{image}": images["dashboard"]}
    if "auth" in images:
        values["{authImage}"] = images["auth"]
    return [values.get(argument, argument) for argument in arguments]


def run(directory):
    """Perform a journaled operation exactly once; interruption never authorizes replay."""
    canonical(str(directory), directory=True, private=True)
    intent = json.loads(read_file(directory / "intent.json"))
    target, release = intent["target"], intent["release"]
    if operation_directory(target, intent["id"]) != directory:
        raise Refusal("operation_changed")
    # Wait for the submitter to release its directory lock after systemd has executed us.
    with directory_lock(Path(target["directory"]), wait=15):
        current = json.loads(read_file(directory / "status.json"))
        if (current.get("phase") != "accepted" or current.get("changesStarted") is not False or
                current.get("requestHash") != digest(encoded(intent)) or current.get("id") != intent["id"]):
            raise Refusal("operation_replay")
        def phase(name, **fields):
            current.update(phase=name, **fields)
            save_status(directory, current)
        sources, written = {}, {}
        try:
            phase("checking")
            if inspect(target, release, drained=True) != intent["expected"]:
                raise Refusal("confirmation_changed")
            config = configured(target)
            images = release_images(release)
            apps = {service["app"] for service in target["services"]}
            if target.get("browserConfigFile"):
                apps.add("mira-browser")
            phase("pulling")
            identities = {}
            for app in sorted(apps):
                command(["/usr/bin/docker", "pull", "--platform=linux/amd64", images[app]], target["directory"], timeout=300)
                identities[app] = image_identity(target, images[app], release)
            if inspect(target, release, drained=True) != intent["expected"]:
                raise Refusal("confirmation_changed")
            compose_path = Path(target["composeFile"])
            sources[compose_path] = read_file(compose_path)
            replacement, expected_config = compose_replacement(sources[compose_path], config, target, images)
            replace_file(directory / "compose.before", sources[compose_path])
            browser_path, browser_replacement, bindings = None, None, []
            if target.get("browserConfigFile"):
                browser_path = Path(target["browserConfigFile"])
                sources[browser_path] = read_file(browser_path)
                browser_config = json.loads(sources[browser_path])
                bindings = browser_bindings(target, browser_config, intent["expected"]["containers"])
                browser_config["imageId"] = identities["mira-browser"]
                browser_replacement = encoded(browser_config)
                replace_file(directory / "browser.before", sources[browser_path])
            phase("stopping", changesStarted=True)
            command(["/usr/bin/systemctl", "stop", *target["units"]], target["directory"], timeout=120)
            if any(container(target, service["name"])["running"] for service in target["services"]):
                raise Refusal("stop_verification")
            phase("backup")
            backup = directory / "database.dump"
            descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as output:
                command(recipe(target["backupCommand"], directory, images), target["directory"], timeout=300, output_file=output)
                output.flush()
                os.fsync(output.fileno())
            with backup.open("rb") as stream:
                if stream.read(5) != b"PGDMP":
                    raise Refusal("backup_verification")
            command(["/usr/bin/pg_restore", "--list", str(backup)], target["directory"])
            phase("configuring")
            replace_file(compose_path, replacement, sources[compose_path])
            written[compose_path] = replacement
            if browser_path is not None:
                replace_file(browser_path, browser_replacement, sources[browser_path])
                written[browser_path] = browser_replacement
            if configured(target) != expected_config:
                raise Refusal("configuration_changed")
            # Persist this boundary before invoking the migrator, including when its exit is unknown.
            phase("migrating", migrationStarted=True)
            command(recipe(target["migrateCommand"], directory, images), target["directory"], timeout=300)
            phase("starting")
            references = {service["name"]: images[service["app"]] for service in target["services"]}
            expected_ids = {service["name"]: identities[service["app"]] for service in target["services"]}
            if bindings:
                refreshed, browser_config = start_browser_proxies(target, bindings, browser_path, browser_config,
                    written[browser_path], references, expected_ids)
                written[browser_path] = refreshed
            command(["/usr/bin/systemctl", "start", *target["units"]], target["directory"], timeout=120)
            phase("verifying")
            observed = verify_services(target, references, expected_ids)
            if bindings and browser_slots(target, bindings, observed) != browser_config["networks"]:
                raise Refusal("browser_proxy_verification")
            if configured(target) != expected_config or any(read_file(path) != content for path, content in written.items()):
                raise Refusal("configuration_changed")
            phase("complete", state="succeeded", version=release["version"], revision=release["revision"], containers=observed)
        except Exception as error:
            code = str(error) if isinstance(error, Refusal) else "operation_failed"
            recovered = not current["changesStarted"]
            if current["changesStarted"] and not current["migrationStarted"]:
                try:
                    if bindings:
                        command(["/usr/bin/systemctl", "stop", *target["units"]], target["directory"], timeout=120)
                        if any(container(target, service["name"])["running"] for service in target["services"]):
                            raise Refusal("stop_verification")
                    for path, content in written.items():
                        replace_file(path, sources[path], content)
                    previous = intent["expected"]["containers"]
                    references = {name: value["image"] for name, value in previous.items()}
                    previous_ids = {name: value["imageId"] for name, value in previous.items()}
                    if bindings:
                        start_browser_proxies(target, bindings, browser_path, json.loads(sources[browser_path]),
                            sources[browser_path], references, previous_ids)
                    command(["/usr/bin/systemctl", "start", *target["units"]], target["directory"], timeout=120)
                    observed = verify_services(target, references, previous_ids)
                    verify_browser_recovery(target, directory, intent["expected"], observed)
                    if configured(target) != config or read_file(compose_path) != sources[compose_path]:
                        raise Refusal("configuration_changed")
                    recovered = True
                except Exception:
                    recovered = False
            phase("failed", state="failed", code=code, recovered=recovered)


def recover(directory, database_restored=False):
    """Operator-only recovery: verify the original deployment after controlled database restoration."""
    canonical(str(directory), directory=True, private=True)
    intent = json.loads(read_file(directory / "intent.json"))
    target = intent["target"]
    if operation_directory(target, intent["id"]) != directory:
        raise Refusal("operation_changed")
    with directory_lock(Path(target["directory"])):
        unit = "homelab-release-" + intent["id"].replace("-", "") + ".service"
        if unit_state(target, unit)["active"] in {"active", "activating", "deactivating"}:
            raise Refusal("host_busy")
        current = status(target, intent["id"])
        if current["state"] not in {"unknown", "failed"}:
            raise Refusal("recovery_invalid")
        if current["migrationStarted"] and not database_restored:
            raise Refusal("database_recovery_required")
        before = intent["expected"]
        if (digest(read_file(Path(target["composeFile"]))) != before["composeHash"] or
                digest(encoded(configured(target))) != before["configHash"]):
            raise Refusal("configuration_changed")
        observed = verify_services(target, {name: value["image"] for name, value in before["containers"].items()},
                        {name: value["imageId"] for name, value in before["containers"].items()})
        verify_browser_recovery(target, directory, before, observed)
        current.update(state="failed", phase="failed", code="operator_recovered", recovered=True)
        save_status(directory, current)


def database_environment(value, root_certificate=None):
    """Translate a PostgreSQL URL and optional CA fallback into a minimal libpq environment."""
    parsed = urlsplit(value)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or not parsed.username or not parsed.path.startswith("/") or len(parsed.path) < 2 or parsed.fragment:
        raise Refusal("backup_configuration")
    result = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "PGCONNECT_TIMEOUT": "10",
              "PGHOST": parsed.hostname, "PGPORT": str(parsed.port or 5432),
              "PGUSER": unquote(parsed.username), "PGDATABASE": unquote(parsed.path[1:])}
    if parsed.password is not None:
        result["PGPASSWORD"] = unquote(parsed.password)
    options = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT",
               "sslkey": "PGSSLKEY", "channel_binding": "PGCHANNELBINDING", "connect_timeout": "PGCONNECT_TIMEOUT"}
    seen = set()
    for key, item in parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True):
        if key not in options or key in seen:
            raise Refusal("backup_configuration")
        seen.add(key)
        result[options[key]] = item
    if "PGSSLROOTCERT" not in result and root_certificate is not None:
        result["PGSSLROOTCERT"] = root_certificate
    if not result["PGCONNECT_TIMEOUT"].isdigit() or not 1 <= int(result["PGCONNECT_TIMEOUT"]) <= 30:
        raise Refusal("backup_configuration")
    if any(not item or len(item) > 8192 or "\0" in item or "\n" in item or "\r" in item for item in result.values()):
        raise Refusal("backup_configuration")
    return result


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "run":
        run(Path(sys.argv[2]))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "recover":
        if len(sys.argv) not in {3, 4} or (len(sys.argv) == 4 and sys.argv[3] != "--database-restored"):
            raise Refusal("recovery_invalid")
        recover(Path(sys.argv[2]), len(sys.argv) == 4)
        return
    if len(sys.argv) > 1 and sys.argv[1] == "backup":
        if len(sys.argv) > 3 or (len(sys.argv) == 3 and sys.argv[2] != "auth"):
            raise Refusal("backup_configuration")
        database = os.environ.get("HOMELAB_AUTH_DATABASE_URL" if len(sys.argv) == 3 else "HOMELAB_DASHBOARD_DATABASE_URL")
        if not database:
            raise Refusal("backup_configuration")
        os.execve("/usr/bin/pg_dump", ["/usr/bin/pg_dump", "--format=custom", "--no-owner", "--no-acl"],
                  database_environment(database, os.environ.get("PGSSLROOTCERT")))
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise Refusal("request_limit")
    request = json.loads(raw)
    def expired(_signal, _frame):
        raise Refusal("request_expired")
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(90)
    if request["mode"] == "inspect":
        result = inspect(request["target"], request["release"], request.get("allowCurrent") is True)
    elif request["mode"] == "status":
        result = status(request["target"], request["id"])
    elif request["mode"] == "submit":
        source = globals().get("SOURCE") or Path(__file__).read_text()
        result = submit(request, source)
    else:
        raise Refusal("operation_invalid")
    print(json.dumps({"ok": True, "result": result}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, Refusal) else "operation_failed"
        print(json.dumps({"ok": False, "code": code}), flush=True)
        sys.exit(1)
