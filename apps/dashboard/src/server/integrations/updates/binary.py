"""Official, exact-version native artifacts; no publisher-controlled URLs or commands."""
import json
import stat
import zipfile


# Archive layouts and version commands belong to the provider, not deployment input.
BINARY_RELEASES = {
    "adguardhome-sync": ("bakito/adguardhome-sync", "adguardhome-sync_{version}_linux_{arch}.tar.gz", "adguardhome-sync", ["--version"], "checksums.txt"),
    "node-exporter": ("prometheus/node_exporter", "node_exporter-{version}.linux-{arch}.tar.gz", "node_exporter-{version}.linux-{arch}/node_exporter", ["--version"], "sha256sums.txt"),
    "smartctl-exporter": ("prometheus-community/smartctl_exporter", "smartctl_exporter-{version}.linux-{arch}.tar.gz", "smartctl_exporter-{version}.linux-{arch}/smartctl_exporter", ["--version"], "sha256sums.txt"),
    "blackbox-exporter": ("prometheus/blackbox_exporter", "blackbox_exporter-{version}.linux-{arch}.tar.gz", "blackbox_exporter-{version}.linux-{arch}/blackbox_exporter", ["--version"], "sha256sums.txt"),
    "alertmanager": ("prometheus/alertmanager", "alertmanager-{version}.linux-{arch}.tar.gz", "alertmanager-{version}.linux-{arch}/alertmanager", ["--version"], "sha256sums.txt"),
    "victoriametrics": ("VictoriaMetrics/VictoriaMetrics", "victoria-metrics-linux-{arch}-v{version}.tar.gz", "victoria-metrics-prod", ["-version"], None),
    "vmalert": ("VictoriaMetrics/VictoriaMetrics", "vmutils-linux-{arch}-v{version}.tar.gz", "vmalert-prod", ["-version"], None),
    "vmbackup": ("VictoriaMetrics/VictoriaMetrics", "vmutils-linux-{arch}-v{version}.tar.gz", "vmbackup-prod", ["-version"], None),
    "alloy": ("grafana/alloy", "alloy-linux-{arch}.zip", "alloy-linux-{arch}", ["--version"], None),
    "loki": ("grafana/loki", "loki-linux-{arch}.zip", "loki-linux-{arch}", ["-version"], None),
    "traefik": ("traefik/traefik", "traefik_v{version}_linux_{arch}.tar.gz", "traefik", ["version"], "traefik_v{version}_checksums.txt"),
}


def binary_version(component, output):
    """Parse the provider's release line, excluding embedded Go/runtime versions."""
    if component in {"victoriametrics", "vmalert", "vmbackup"}:
        name = "victoria-metrics" if component == "victoriametrics" else component
        pattern = r"^" + name + r"-\d{8}-\d{6}-tags-v(\d+\.\d+\.\d+)-\d+-g[0-9a-f]+$"
    elif component == "traefik":
        pattern = r"^Version:\s+(\d+\.\d+\.\d+)\s*$"
    else:
        name = component.replace("-exporter", "_exporter")
        pattern = r"^" + re.escape(name) + r",? version v?(\d+\.\d+\.\d+)(?:\s|$)"
    matches = re.findall(pattern, output, re.M)
    if len(matches) != 1:
        raise RuntimeError("Native release version is ambiguous")
    return matches[0]


def binary_metadata(binary):
    """Fence the executable and refuse unqualified capabilities/special modes."""
    native_file(str(binary))
    value = binary.stat()
    if value.st_mode & 0o7000 or os.listxattr(binary, follow_symlinks=False):
        raise RuntimeError("Native executable metadata requires deployment review")
    return value.st_ino, value.st_ctime_ns, value.st_mode, value.st_uid, value.st_gid


def release_binary(component, version, architecture):
    """Download an exact official asset, verify its digest and read only its executable."""
    repository, asset, member, _arguments, checksum = BINARY_RELEASES[component]
    substitutions = {"version": version, "arch": architecture}
    asset, member = asset.format(**substitutions), member.format(**substitutions)
    base = "https://github.com/" + repository + "/releases/download/v" + version + "/"
    metadata = json.loads(native_download("https://api.github.com/repos/" + repository + "/releases/tags/v" + version, 2_000_000))
    if metadata.get("tag_name") != "v" + version or metadata.get("draft") or metadata.get("prerelease"):
        raise RuntimeError("Native release is not the approved stable version")
    matches = [item for item in metadata.get("assets", []) if item.get("name") == asset]
    if len(matches) != 1 or matches[0].get("browser_download_url") != base + asset:
        raise RuntimeError("Official native release asset is unavailable")
    digest = matches[0].get("digest")
    if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        if checksum is None:
            raise RuntimeError("Native release has no verified integrity digest")
        sums = native_download(base + checksum.format(**substitutions), 1_048_576).decode("utf-8")
        hashes = [line.split()[0] for line in sums.splitlines() if len(line.split()) == 2 and line.split()[1].removeprefix("*").removeprefix("./") == asset]
        if len(hashes) != 1 or not re.fullmatch(r"[a-f0-9]{64}", hashes[0]):
            raise RuntimeError("Native release checksum is unavailable")
        digest = "sha256:" + hashes[0]
    archive = native_download(base + asset, 268_435_456)
    if hashlib.sha256(archive).hexdigest() != digest.removeprefix("sha256:"):
        raise RuntimeError("Native release integrity verification failed")
    limit = 536_870_912
    if asset.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            members = [item for item in package.infolist() if item.filename == member]
            if len(members) != 1 or members[0].is_dir() or stat.S_ISLNK(members[0].external_attr >> 16) or not 0 < members[0].file_size <= limit:
                raise RuntimeError("Native archive executable is invalid")
            with package.open(members[0]) as stream:
                contents = stream.read(limit + 1)
    else:
        # Stream multi-program archives (such as vmutils) instead of materializing
        # every decompressed binary in RAM. Never extract archive-controlled paths.
        contents = None
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r|gz") as package:
            for count, entry in enumerate(package):
                if count >= 10_000 or entry.offset_data + entry.size > 1_073_741_824:
                    raise RuntimeError("Native archive expansion exceeds its budget")
                if entry.name.removeprefix("./") != member:
                    continue
                if contents is not None or not entry.isfile() or not 0 < entry.size <= limit:
                    raise RuntimeError("Native archive executable is invalid")
                stream = package.extractfile(entry)
                if stream is None:
                    raise RuntimeError("Native archive executable is missing")
                with stream:
                    contents = stream.read(limit + 1)
        if contents is None:
            raise RuntimeError("Native archive executable is missing")
    if not 0 < len(contents) <= limit or not contents.startswith(b"\x7fELF"):
        raise RuntimeError("Native archive does not contain a bounded Linux executable")
    return contents


def binary_install(recipe, installed, candidate, run, emit, replace, lock):
    """Replace one existing qualified binary and preserve its service's running state."""
    component = recipe.get("component", recipe["application"])
    binary = native_file(recipe["binary"])
    arguments = BINARY_RELEASES[component][3]
    with lock(binary.parent):
        metadata = binary_metadata(binary)
        if binary.stat().st_size > 536_870_912:
            raise RuntimeError("Native executable exceeds its budget")
        before = file_digest(binary)
        def version(path):
            return binary_version(component, run([str(path), *arguments]))
        if version(binary) != installed:
            raise RuntimeError("Native version changed")
        service = recipe.get("service")
        active = native_service(service, run) if service else False
        architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(run(["/usr/bin/uname", "-m"]))
        if architecture is None:
            raise RuntimeError("Unsupported native architecture")
        emit("downloading")
        contents = release_binary(component, candidate, architecture)
        with tempfile.TemporaryDirectory(prefix=".homelab-native-", dir=binary.parent) as temporary:
            staged = Path(temporary) / "application"
            staged.write_bytes(contents)
            staged.chmod(0o700)
            if version(staged) != candidate:
                raise RuntimeError("Native release version differs from approval")
            if binary_metadata(binary) != metadata or version(binary) != installed or (service and native_service(service, run) != active):
                raise RuntimeError("Native installation changed during preparation")
            emit("installing")
            replace(binary, contents, before)
        if active:
            emit("restarting")
            run(["/usr/bin/systemctl", "restart", service])
        if version(binary) != candidate or (service and native_service(service, run) != active):
            raise RuntimeError("Native activation failed")
        return active


def codex_install(recipe, installed, candidate, run, emit, lock):
    """Upgrade the existing npm installation as its owner without touching credentials."""
    import pwd
    prefix = Path(recipe["prefix"])
    manifest = native_file(str(prefix / "lib/node_modules/@openai/codex/package.json"))
    owner = pwd.getpwnam(recipe["user"])
    if prefix.resolve() != prefix or prefix.stat().st_uid != owner.pw_uid or manifest.stat().st_uid != owner.pw_uid:
        raise RuntimeError("Codex installation owner changed")
    base = ["/usr/sbin/runuser", "-u", recipe["user"], "--", recipe["node"]]
    inspect = base + [str(prefix / "lib/node_modules/@openai/codex/bin/codex.js"), "--version"]
    with lock(prefix):
        package = json.loads(manifest.read_text())
        if package.get("name") != "@openai/codex" or package.get("version") != installed or native_version(run(inspect)) != installed:
            raise RuntimeError("Codex version changed")
        emit("installing")
        # No persistent package-manager cache/logs or lifecycle scripts are added.
        with tempfile.TemporaryDirectory(prefix=".homelab-npm-", dir=prefix) as temporary:
            os.chown(temporary, owner.pw_uid, owner.pw_gid)
            run(base + [recipe["npm"], "install", "--global", "--prefix", str(prefix), "--cache", temporary,
                        "--registry=https://registry.npmjs.org", "--ignore-scripts", "--no-audit", "--no-fund", "--logs-max=0", "@openai/codex@" + candidate], timeout=1200)
        if json.loads(manifest.read_text()).get("version") != candidate or native_version(run(inspect)) != candidate:
            raise RuntimeError("Codex package and executable versions do not match approval")
        return False


def python_application_install(recipe, installed, candidate, run, emit, lock):
    """Install one verified wheel in its existing venv without upgrading unrelated dependencies."""
    directory = Path(recipe["directory"])
    if directory.resolve() != directory or directory.stat().st_uid != os.geteuid() or directory.stat().st_mode & 0o022:
        raise RuntimeError("Python application installation ownership changed")
    python = directory / "bin/python"
    base = [str(python), "-I", "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-cache-dir"]
    package = "prometheus-pve-exporter"
    inspect = [str(python), "-I", "-c", "import importlib.metadata; print(importlib.metadata.version('prometheus-pve-exporter'))"]
    with lock(directory):
        if run(inspect) != installed:
            raise RuntimeError("Python application version changed")
        active = native_service(recipe["service"], run)
        emit("downloading")
        metadata = json.loads(native_download("https://pypi.org/pypi/" + package + "/" + candidate + "/json", 1_048_576))
        if metadata.get("info", {}).get("name") != package or metadata.get("info", {}).get("version") != candidate:
            raise RuntimeError("Unexpected Python release identity")
        filename = "prometheus_pve_exporter-" + candidate + "-py3-none-any.whl"
        assets = [asset for asset in metadata.get("urls", []) if asset.get("filename") == filename and not asset.get("yanked")]
        if len(assets) != 1:
            raise RuntimeError("The official Python release has no supported wheel")
        asset = assets[0]
        url = urllib.parse.urlsplit(asset.get("url", ""))
        digest = asset.get("digests", {}).get("sha256", "")
        if url.scheme != "https" or url.hostname != "files.pythonhosted.org" or url.username or url.password or url.port not in (None, 443) or url.path.rsplit("/", 1)[-1] != filename or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise RuntimeError("Unexpected Python release artifact")
        content = native_download(asset["url"], 10_485_760)
        if hashlib.sha256(content).hexdigest() != digest:
            raise RuntimeError("Python release integrity verification failed")
        with tempfile.TemporaryDirectory(prefix=".homelab-python-", dir=directory) as temporary:
            wheel = Path(temporary) / filename
            wheel.write_bytes(content)
            arguments = base + ["install", "--quiet", "--no-index", "--only-binary=:all:"]
            # Existing dependencies must satisfy the candidate before mutation. A
            # dependency migration requires its own reviewed plan, never an implicit
            # unbounded pip upgrade alongside a patch/minor application update.
            plan = json.loads(run(arguments + ["--dry-run", "--report", "-", str(wheel)]))
            changes = plan.get("install", [])
            if len(changes) != 1 or changes[0].get("metadata", {}).get("name") != package or changes[0].get("metadata", {}).get("version") != candidate:
                raise RuntimeError("Python dependencies require a separate update plan")
            if run(inspect) != installed or native_service(recipe["service"], run) != active:
                raise RuntimeError("Python application changed during preparation")
            emit("installing")
            run(arguments + ["--no-deps", str(wheel)], timeout=1200)
        if run(inspect) != candidate:
            raise RuntimeError("Python application version did not match approval")
        run(base + ["check"])
        if active:
            emit("restarting")
            run(["/usr/bin/systemctl", "restart", recipe["service"]])
        if native_service(recipe["service"], run) != active:
            raise RuntimeError("Python application activation failed")
        return active
