"""One ephemeral, narrowly selected update invocation over an authenticated SSH channel.

No service is installed. Input is created by the worker, never accepted as a browser
command. Output contains only fixed progress phases and the verified version receipt.
"""
import copy
from contextlib import contextmanager
import fcntl
import json
import os
import posixpath
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time


def command(arguments, timeout=120, environment=None, output_limit=2_000_000):
    """Execute argv without a shell, bounding output, runtime and child lifetime."""
    selected_environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C", "HOME": "/nonexistent", "DEBIAN_FRONTEND": "noninteractive"}
    if environment is not None:
        selected_environment.update(environment)
    process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True, env=selected_environment)
    output = bytearray()
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise RuntimeError("Command deadline exceeded")
                for key, _ in selector.select(0.2):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        selector.unregister(key.fd)
                    else:
                        output.extend(chunk)
                        if len(output) > output_limit:
                            raise RuntimeError("Command output exceeded its budget")
        if process.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
            raise RuntimeError("Update command failed")
        return output.decode("utf-8", errors="strict").strip()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        process.stdout.close()


def progress(phase):
    """Emit only a code-owned phase, never package-manager or application output."""
    print(json.dumps({"phase": phase}), flush=True)


class UpdateRefusal(RuntimeError):
    """Carry a fixed error category without exposing command output or secrets."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def startup_code_paths(startup):
    """Infer executable/interpreter positions, never ordinary data-path operands."""
    paths = set()
    unqualified = False
    def executable_expansion(value):
        quote, index = None, 0
        while index < len(value):
            character = value[index]
            following = value[index + 1:index + 3]
            if quote == "'":
                if character == "'":
                    quote = None
            elif character == "\\":
                index += 1
            elif character == '"' or character == "'" and quote is None:
                quote = None if quote == character else character
            elif character == "`" or character == "$" and following.startswith("(") and following != "((" or quote is None and character in "<>" and following.startswith("("):
                return True
            index += 1
        return False
    def tokens(value):
        def unquote(match):
            if match[1] is not None:
                return re.sub(r'\\(["\\$`])', r'\1', match[1].replace("\\\n", ""))
            return match[2] if match[2] is not None else "" if match[3] == "\n" else match[3]
        # Preserve separator provenance before unquoting literal argument values.
        return [(re.sub(r'''"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])''', unquote, word),
                 re.fullmatch(r"[;|&\n]+", word) is not None)
                for word in re.findall(r'''(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|\\[\s\S]|[^\s;|&"'\\])+|[;|&]+|\n''', value)
                if word != "\\\n"]
    def words(value):
        return [word for word, separator in tokens(value) if not separator or word != "\n"]
    def argv(value):
        return words(value) if isinstance(value, str) else value or []
    def resolve(cwd, value):
        return posixpath.normpath(posixpath.join(cwd, value))
    def inspect(args, cwd, depth=0):
        nonlocal unqualified
        if not args or not args[0] or args[0].startswith("-"):
            return
        if depth > 8:
            paths.add(cwd)
            return
        executable, name = args[0], posixpath.basename(args[0])
        if "/" in executable:
            paths.add(resolve(cwd, executable))
        if name == "env":
            current, options, splits, index = cwd, True, 0, 1
            expanded = list(args)
            while index < len(expanded):
                arg = expanded[index]
                if options and arg in ("--", "-"):
                    options = False
                    index += 1
                    continue
                if options and arg.startswith("-"):
                    long = re.fullmatch(r"--(unset|chdir|split-string|argv0|file)(?:=(.*))?", arg)
                    short = re.fullmatch(r"-[i0v]*([uCSaf])(.*)", arg)
                    option = long[1] if long else short[1] if short else None
                    if option:
                        value = long[2] if long else short[2] or None
                        if value is None:
                            index += 1
                            if index >= len(expanded):
                                return
                            value = expanded[index]
                        if option in ("C", "chdir"):
                            current = resolve(cwd, value)
                        if option in ("S", "split-string"):
                            splits += 1
                            if splits > 8:
                                paths.add(current)
                                return
                            expanded[index + 1:index + 1] = words(value)
                    index += 1
                    continue
                options = False
                if re.match(r"[A-Za-z_][A-Za-z0-9_]*=", arg):
                    index += 1
                    continue
                break
            inspect(expanded[index:], current, depth + 1)
        elif name in ("exec", "tini", "dumb-init", "gosu", "su-exec", "docker-entrypoint.sh", "docker-entrypoint"):
            index = 2 if name in ("gosu", "su-exec") else 1
            while index < len(args) and (args[index].startswith("-") or re.match(r"[A-Za-z_][A-Za-z0-9_]*=", args[index])):
                index += 1
            inspect(args[index:], cwd, depth + 1)
        elif name in ("sh", "bash", "dash", "ksh", "zsh", "ash"):
            inline = next((index for index, arg in enumerate(args) if index > 0 and re.match(r"^-[^-]*c", arg)), None)
            if inline is not None:
                if executable_expansion(args[inline + 1] if len(args) > inline + 1 else ""):
                    unqualified = True
                    return
                group, current = [], cwd
                for token, separator in tokens(args[inline + 1] if len(args) > inline + 1 else "") + [(";", True)]:
                    if separator:
                        # Assignment values are data, even if they contain paths.
                        while group and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", group[0]):
                            group.pop(0)
                        if len(group) > 1 and group[0] == "cd":
                            current = resolve(current, group[1])
                        else:
                            inspect(group, current, depth + 1)
                        group = []
                    else:
                        group.append(token)
            else:
                script = next((arg for arg in args[1:] if not arg.startswith("-")), None)
                if script:
                    paths.add(resolve(cwd, script))
        elif name in (".", "source"):
            if len(args) > 1:
                paths.add(resolve(cwd, args[1]))
        elif re.fullmatch(r"(?:python(?:\d+(?:\.\d+)*)?|node|nodejs|bun|deno|ruby|perl|php|lua|luajit|npm|npx|yarn|pnpm)", name):
            paths.add(cwd)
            if re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", name):
                index = 1
                while index < len(args):
                    arg = args[index]
                    if arg == "--":
                        if len(args) > index + 1 and args[index + 1] != "-":
                            paths.add(resolve(cwd, args[index + 1]))
                        break
                    if arg == "-" or re.match(r"^-[cm]", arg):
                        break
                    if arg in ("-X", "-W", "--check-hash-based-pycs"):
                        index += 2
                        continue
                    if not arg.startswith("-"):
                        paths.add(resolve(cwd, arg))
                        break
                    index += 1
                return
            script = next((arg for arg in args[1:] if not arg.startswith("-")), None)
            if script and not any(arg in args for arg in ("-m", "-c", "-e", "--eval", "--print")):
                paths.add(resolve(cwd, script))
    first, second = argv(startup.get("entrypoint")), argv(startup.get("command"))
    cwd = resolve("/", startup.get("working_dir") or "/")
    inspect(first + second, cwd)
    healthcheck = startup.get("healthcheck") or {}
    health_test = healthcheck.get("Test", healthcheck.get("test")) or []
    if isinstance(health_test, str):
        health_test = ["CMD-SHELL", health_test]
    if not healthcheck.get("disable"):
        if health_test and health_test[0] == "CMD":
            inspect(health_test[1:], cwd)
        elif health_test and health_test[0] == "CMD-SHELL":
            inspect(["/bin/sh", "-c", health_test[1] if len(health_test) > 1 else ""], cwd)
    return None if unqualified else paths


def compose_startup(service, defaults):
    """Apply Compose null/empty/omitted startup semantics to installed image defaults."""
    entrypoint = service.get("entrypoint")
    command = service.get("command")
    result = {
        "entrypoint": defaults.get("entrypoint") if entrypoint is None else entrypoint,
        "command": command if command is not None else defaults.get("command") if entrypoint is None else [],
        "working_dir": service.get("working_dir") or defaults.get("working_dir") or "/",
    }
    health = defaults.get("healthcheck") or {}
    override = service.get("healthcheck") or {}
    health_test = health.get("Test", health.get("test"))
    if override.get("disable"):
        health_test = ["NONE"]
    elif override.get("test") is not None:
        health_test = override["test"]
    if health_test is not None:
        result["healthcheck"] = {"test": health_test}
    return result


def verify_code_mounts(service, startup=None):
    """Refuse executable deployment mounts without reading config/secret contents."""
    paths = startup_code_paths(startup or service)
    mounts = list(service.get("volumes", []))
    for kind, base in (("configs", "/"), ("secrets", "/run/secrets")):
        for entry in service.get(kind, []):
            target = entry if isinstance(entry, str) else entry.get("target") or entry["source"]
            # These sources are Compose object names, never filesystem paths.
            # Only their effective container destinations are needed to qualify code.
            mounts.append({"target": posixpath.join(base, target)})
    for mount in mounts:
        destination = mount.get("target", "")
        # Only the qualified standalone logout helper is exempt, not this directory.
        if destination == "/opt/homelab/logout-worker.js":
            continue
        normalized = posixpath.normpath(destination)
        startup_code = paths is None or any(path == normalized or path.startswith(normalized.rstrip("/") + "/") for path in paths)
        # Named-volume identifiers are not host paths. Their target/startup
        # relationship still matters: updating the image does not replace them.
        source = mount.get("source") if mount.get("type") == "bind" else None
        executable = False
        if source:
            metadata = Path(source).stat()
            executable = Path(source).is_file() and bool(metadata.st_mode & 0o111)
        if executable or startup_code or re.search(r"\.(?:py|pyc|js|mjs|cjs|jsx|ts|tsx|so|node|sh|bash|dash|ksh|zsh|fish|pl|rb|php|lua|ps1|exe|dll|wasm)$", destination, re.I) or re.fullmatch(r"(?:/app(?:/(?:src|lib|services|providers|api|utils|cw_platform)(?:/.*)?)?|/(?:usr/(?:local/)?)?(?:bin|sbin|libexec|lib|lib32|lib64)(?:/.*)?|/usr/share/(?:nodejs|node_modules|python\d*(?:\.\d+)*|perl\d*|php|ruby)(?:/.*)?)/?", normalized):
            raise UpdateRefusal("local_code_override")


def file_digest(path):
    """Hash a large executable incrementally rather than holding its old copy in RAM."""
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def atomic_content(path, contents, expected):
    """Replace one nonsymlink file only if its prior bytes and ownership still match."""
    def matches():
        return file_digest(path) == expected if isinstance(expected, str) else path.read_bytes() == expected
    if path.is_symlink() or path.resolve() != path or not matches():
        raise RuntimeError("Update source changed")
    metadata = path.stat()
    attributes = {name: os.getxattr(path, name, follow_symlinks=False)
                  for name in os.listxattr(path, follow_symlinks=False)}
    # Preserve workspace access ACLs when replacing the inode. Other extended
    # security metadata (for example capabilities) still needs qualification.
    if metadata.st_mode & 0o7000 or set(attributes) - {"system.posix_acl_access"}:
        raise RuntimeError("Update source metadata requires deployment review")
    descriptor, temporary = tempfile.mkstemp(prefix=".homelab-update-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(contents)
            output.flush()
            os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(output.fileno(), metadata.st_mode & 0o777)
            # The source's ACL (or its absence), not an inherited default ACL,
            # defines access to the replacement file.
            for name in os.listxattr(output.fileno()):
                if name not in attributes:
                    os.removexattr(output.fileno(), name)
            for name, value in attributes.items():
                os.setxattr(output.fileno(), name, value)
            staged = os.fstat(output.fileno())
            if (staged.st_mode & 0o777, staged.st_uid, staged.st_gid) != (metadata.st_mode & 0o777, metadata.st_uid, metadata.st_gid) or {name: os.getxattr(output.fileno(), name) for name in os.listxattr(output.fileno())} != attributes:
                raise RuntimeError("Update source metadata could not be preserved")
            os.fsync(output.fileno())
        if path.is_symlink() or path.stat().st_ino != metadata.st_ino or path.stat().st_ctime_ns != metadata.st_ctime_ns or not matches():
            raise RuntimeError("Update source changed")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def inspect_container(identity):
    """Read only lifecycle/image identity and Compose ownership labels."""
    template = '{{json .Name}},{{json .Config.Image}},{{json .Image}},{{json .State.Status}},{{json (index .Config.Labels "com.docker.compose.project")}},{{json (index .Config.Labels "com.docker.compose.service")}}'
    return json.loads("[" + command(["/usr/bin/docker", "inspect", "--format", template, identity]) + "]")


def compose_environment(driver):
    """Load explicitly selected interpolation values on the target, never into a file or receipt."""
    source = driver.get("environment")
    if source is None:
        return None
    raw = command(source["command"], timeout=30, output_limit=65_536)
    if len(raw.encode("utf-8")) > 65_536:
        raise RuntimeError("Compose environment exceeds its budget")
    values = json.loads(raw)
    if not isinstance(values, dict):
        raise RuntimeError("Compose environment must be a JSON object")
    selected = {"COMPOSE_DISABLE_ENV_FILE": "1"}
    for name in source["variables"]:
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,99}", name) or re.match(r"^(?:COMPOSE_|DOCKER_|LD_|DYLD_|PYTHON|BASH|SHELL)", name) or name in {"PATH", "HOME", "ENV", "IFS", "LC_ALL", "LANG"}:
            raise RuntimeError("Unsafe Compose environment variable")
        value = values.get(name)
        if not isinstance(value, str) or "\x00" in value or len(value.encode("utf-8")) > 16_384:
            raise RuntimeError("A required Compose environment value is invalid")
        selected[name] = value
    return selected


@contextmanager
def locked_directory(directory):
    """Serialize our Compose edits without leaving a lock or backup file behind."""
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def docker_update(driver, item, automatic=False):
    """Update one image, coordinating approved namespace consumers without changing theirs."""
    candidate = item["availableImage"]
    if not re.fullmatch(r"(?:docker.io|ghcr.io)/[a-z0-9][a-z0-9_./-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[a-f0-9]{64}", candidate):
        raise RuntimeError("An immutable public image candidate is required")
    def repository(reference):
        value = reference.split("@")[0]
        if ":" in value.rsplit("/", 1)[-1]:
            value = value.rsplit(":", 1)[0]
        for prefix in ["registry-1.docker.io/", "index.docker.io/", "docker.io/"]:
            if value.startswith(prefix):
                value = value[len(prefix):]
                break
        if value.startswith("ghcr.io/"):
            return value
        return "docker.io/" + ("library/" if "/" not in value else "") + value
    if repository(item["image"]) != repository(candidate):
        raise RuntimeError("An update cannot change the image repository")
    identity = item["id"].removeprefix("docker:")
    if not re.fullmatch(r"[a-f0-9]{64}", identity):
        raise RuntimeError("Invalid container identity")
    directory, path, main_file = Path(driver["directory"]), Path(driver["imageFile"]), Path(driver["file"])
    if directory.resolve() != directory or path.resolve() != path or main_file.resolve() != main_file or directory not in main_file.parents or directory not in path.parents or path.stat().st_size > 2_000_000:
        raise RuntimeError("Untrusted Compose source path")
    base = ["/usr/bin/docker", "compose", "--project-directory", str(directory), "--project-name", driver["project"], "--file", driver["file"]]
    with locked_directory(directory):
        try:
            before = inspect_container(identity)
        except RuntimeError:
            raise UpdateRefusal("container_changed") from None
        if before[:3] != ["/" + driver["name"], item["image"], item["installed"]] or before[4:] != [driver["project"], driver["service"]] or before[3] not in {"running", "exited", "created"}:
            raise UpdateRefusal("container_changed")
        original = path.read_bytes()
        environment = compose_environment(driver)
        def compose(arguments, timeout=120):
            return command(base + arguments, timeout=timeout, environment=environment)
        config = json.loads(compose(["config", "--format", "json"]))
        service = config.get("services", {}).get(driver["service"], {})
        # Inspect only startup vectors, not the environment or complete Config.
        startup = json.loads(command(["/usr/bin/docker", "inspect", "--format", '{"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"working_dir":{{json .Config.WorkingDir}},"healthcheck":{{json .Config.Healthcheck}}}', identity]))
        verify_code_mounts(service, startup)
        # Container Config may contain old Compose overrides. Inherit from the
        # immutable installed image, not from those old container overrides.
        # Never classify an unmerged CMD argument tail as an executable vector.
        defaults = json.loads(command(["/usr/bin/docker", "image", "inspect", "--format", '{"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"working_dir":{{json .Config.WorkingDir}},"healthcheck":{{json .Config.Healthcheck}}}', before[2]]))
        verify_code_mounts(service, compose_startup(service, defaults))
        if config.get("services", {}).get(driver["service"], {}).get("image") != item["image"]:
            raise RuntimeError("Compose and the observed image differ")
        namespace_plan = prepare_namespace_plan(config, driver, compose)
        if before[3] == "running":
            docker_health_checks(driver)
        pattern = re.compile(rb"(?m)^([ \t]+image:[ \t]*)([\"']?)" + re.escape(item["image"].encode()) + rb"\2([ \t]*(?:#[^\r\n]*)?\r?)$")
        matches = list(pattern.finditer(original))
        if len(matches) != 1:
            raise RuntimeError("The source must contain one unambiguous literal image")
        match = matches[0]
        replacement = match[1] + match[2] + candidate.encode() + match[2] + match[3]
        updated = original[:match.start()] + replacement + original[match.end():]
        progress("pulling")
        command(["/usr/bin/docker", "pull", candidate], timeout=600)
        candidate_startup = json.loads(command(["/usr/bin/docker", "image", "inspect", "--format", '{"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},"working_dir":{{json .Config.WorkingDir}},"healthcheck":{{json .Config.Healthcheck}}}', candidate]))
        verify_code_mounts(service, compose_startup(service, candidate_startup))
        pulled = command(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", candidate])
        if pulled != item["available"]:
            raise RuntimeError("Pulled image does not match the approved platform image")
        if automatic:
            old = image_version(item["image"], item["installed"])
            new = image_version(candidate, pulled)
            if not old or not new or old[0] != new[0] or new < old:
                raise RuntimeError("This image change requires manual approval")
        if inspect_container(identity) != before or json.loads(compose(["config", "--format", "json"])) != config:
            raise RuntimeError("Application or Compose configuration changed during preparation")
        verify_namespace_plan(namespace_plan)
        progress("configuring")
        atomic_content(path, updated, original)
        try:
            expected = copy.deepcopy(config)
            expected["services"][driver["service"]]["image"] = candidate
            if json.loads(compose(["config", "--format", "json"])) != expected:
                raise RuntimeError("The Compose edit changed more than the selected image")
        except Exception:
            atomic_content(path, original, updated)
            raise
        progress("installing")
        stop_namespace_consumers(namespace_plan, driver["service"], compose)
        state = ["--wait", "--wait-timeout", "120"] if before[3] == "running" else ["--no-start"]
        try:
            compose(["up", "--detach", "--no-deps", "--no-build", "--pull", "never"] + state + [driver["service"]], timeout=180)
        except RuntimeError:
            raise UpdateRefusal("application_start_failed") from None
        progress("verifying")
        after = inspect_container(driver["name"])
        if after[1:3] != [candidate, item["available"]] or after[4:] != before[4:] or (before[3] == "running" and after[3] != "running") or (before[3] != "running" and after[3] == "running"):
            raise RuntimeError("Application update could not be verified")
        replacements = restore_namespace_consumers(namespace_plan, driver["service"], compose)
        if before[3] == "running":
            docker_health_checks(driver)
        if replacements:
            print(json.dumps({"recreatedContainers": replacements}), flush=True)
        return item["available"]


def image_version(reference, identity):
    """Classify Docker changes using the actual tag or installed image label, not a publisher assertion."""
    tag = reference.split("@")[0].rsplit("/", 1)[-1].split(":")[-1]
    tag = re.sub(r"-(?:alpine|bookworm|bullseye|trixie|slim)[\d.-]*$", "", tag)
    result = stable_parts(tag)
    if result:
        return result
    label = command(["/usr/bin/docker", "image", "inspect", "--format", '{{index .Config.Labels "org.opencontainers.image.version"}}', identity])
    return stable_parts(label)


def stable_parts(version):
    """Conservatively extract Debian upstream numeric versions for automatic admission."""
    value = re.sub(r"^\d+:", "", version)
    value = re.sub(r"-\d[^-]*$", "", value)
    match = re.fullmatch(r"v?(\d+)\.(\d+)(?:\.(\d+))?(?:\+[a-zA-Z0-9.]+)?", value)
    return tuple(int(part or 0) for part in match.groups()) if match else None


def apt_update(item, automatic):
    """Use APT for an exact package candidate, preserving holds and refusing removals."""
    import apt
    import apt_pkg
    name = item["id"].removeprefix("apt:")
    if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?", name):
        raise RuntimeError("Invalid package identity")
    cache = apt.Cache()
    package = cache[name]
    # An earlier package in the same confirmed host batch may have installed this dependency.
    # A fresh local inspection is sufficient for a no-op; never reinstall or accept another version.
    if package.installed and package.installed.version == item["available"]:
        progress("verifying")
        return package.installed.version
    if not package.installed or not package.candidate or package.installed.version != item["installed"] or package.candidate.version != item["available"] or package._pkg.selected_state == apt_pkg.SELSTATE_HOLD:
        raise RuntimeError("Package state or repository candidate changed")
    package.mark_install(auto_fix=True, auto_inst=True, from_user=False)
    changes = cache.get_changes()
    if cache.broken_count or any(change.marked_delete or change._pkg.selected_state == apt_pkg.SELSTATE_HOLD for change in changes):
        raise RuntimeError("The update would remove packages or change held software")
    for change in changes:
        if not change.candidate or (change.installed and apt_pkg.version_compare(change.candidate.version, change.installed.version) < 0):
            raise RuntimeError("Package downgrades are not permitted")
        if automatic:
            old = stable_parts(change.installed.version) if change.installed else None
            new = stable_parts(change.candidate.version)
            if not old or not new or old[0] != new[0] or new < old:
                raise RuntimeError("A dependency requires manual approval")
    versions = [change.fullname + "=" + change.candidate.version for change in changes]
    if not versions or len(versions) > 500:
        raise RuntimeError("Unsupported package update plan")
    progress("installing")
    command(["/usr/bin/apt-get", "--assume-yes", "--no-remove", "--no-install-recommends", "-o", "Dpkg::Options::=--force-confold", "install"] + versions, timeout=1200)
    progress("verifying")
    cache.open()
    installed = cache[name].installed
    if not installed or installed.version != item["available"]:
        raise RuntimeError("Installed package version does not match the approved update")
    return installed.version


def native_update(driver, item):
    """Execute a deployment-reviewed native recipe with one exact version parameter."""
    if "recipe" in driver:
        return install_native_recipe(driver, item, command, progress, atomic_content, locked_directory)
    def version():
        output = command(driver["inspect"])
        values = re.findall(r"(?<![0-9])v?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)", output)
        if len(set(values)) != 1:
            raise RuntimeError("Native version inspection is ambiguous")
        return values[0]
    if version() != item["installed"].removeprefix("v"):
        raise RuntimeError("Native application version changed")
    candidate = item["available"].removeprefix("v")
    if not re.fullmatch(r"\d+\.\d+\.\d+", candidate):
        raise RuntimeError("An exact stable native version is required")
    progress("installing")
    command([argument.replace("{version}", candidate) for argument in driver["install"]], timeout=1200)
    progress("verifying")
    if version() != candidate:
        raise RuntimeError("Native version verification failed")
    command(driver["health"])
    return item["available"]


def reboot_required():
    """Read the distribution flag without turning a failed observation into false."""
    try:
        os.stat("/var/run/reboot-required")
        return True
    except FileNotFoundError:
        return False
    except OSError:
        return None


def main():
    """Dispatch one fixed update operation and return only its redacted receipt."""
    data = sys.stdin.buffer.read(65537)
    if len(data) > 65536:
        raise RuntimeError("Update input exceeds its budget")
    request = json.loads(data)
    progress("checking")
    driver, item = request["driver"], request["item"]
    if driver["kind"] == "docker":
        installed = docker_update(driver, item, request["automatic"])
    elif driver["kind"] == "apt":
        installed = apt_update(item, request["automatic"])
    elif driver["kind"] == "native":
        installed = native_update(driver, item)
    else:
        raise RuntimeError("Unsupported updater")
    receipt = {"complete": True, "installed": installed, "rebootRequired": reboot_required()}
    if driver["kind"] == "docker":
        receipt["containerId"] = command(["/usr/bin/docker", "inspect", "--format", "{{.Id}}", driver["name"]])
    print(json.dumps(receipt), flush=True)


if __name__ == "__main__":
    def interrupted(_number, _frame):
        raise RuntimeError("Update interrupted")
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception as error:
        print(json.dumps({"complete": False, **({"reason": error.reason} if isinstance(error, UpdateRefusal) else {})}), flush=True)
        sys.exit(1)
