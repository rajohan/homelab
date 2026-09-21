"""Versioned runtime installation and explicit default selection; project pins stay untouched."""
import posixpath


def runtime_archive(application, candidate, architecture):
    """Resolve one official stable distribution with its exact integrity checksum."""
    if application == "node":
        arch = {"x86_64": "x64", "aarch64": "arm64"}[architecture]
        stem = "node-v" + candidate + "-linux-" + arch
        name = stem + ".tar.xz"
        base = "https://nodejs.org/dist/v" + candidate + "/"
        sums = native_download(base + "SHASUMS256.txt", 1_048_576).decode()
        matches = [row.split()[0] for row in sums.splitlines() if len(row.split()) == 2 and row.split()[1] == name]
        if len(matches) != 1 or not re.fullmatch(r"[a-f0-9]{64}", matches[0]):
            raise RuntimeError("Node release checksum is unavailable")
        digest = matches[0]
        member = None
    else:
        if application == "bun":
            arch = {"x86_64": "x64-baseline", "aarch64": "aarch64"}[architecture]
            stem = "bun-linux-" + arch
            name, repository, tag, member = stem + ".zip", "oven-sh/bun", "bun-v" + candidate, stem + "/bun"
        else:
            arch = {"x86_64": "amd64", "aarch64": "arm64"}[architecture]
            stem = "gh_" + candidate + "_linux_" + arch
            name, repository, tag, member = stem + ".tar.gz", "cli/cli", "v" + candidate, stem + "/bin/gh"
        base = "https://github.com/" + repository + "/releases/download/" + tag + "/"
        metadata = json.loads(native_download("https://api.github.com/repos/" + repository + "/releases/tags/" + tag, 2_000_000))
        assets = [item for item in metadata.get("assets", []) if item.get("name") == name]
        if metadata.get("tag_name") != tag or metadata.get("draft") or metadata.get("prerelease") or len(assets) != 1 or assets[0].get("browser_download_url") != base + name:
            raise RuntimeError("Runtime release does not match approval")
        value = assets[0].get("digest", "")
        if not isinstance(value, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value):
            raise RuntimeError("Runtime release integrity digest is unavailable")
        digest = value.removeprefix("sha256:")
    archive = native_download(base + name, 268_435_456)
    if hashlib.sha256(archive).hexdigest() != digest:
        raise RuntimeError("Runtime release integrity verification failed")
    return archive, name, stem, member, digest


def extract_runtime(archive, name, stem, member, destination):
    """Extract a bounded vendor tree, rejecting escapes, special files and indirect parents."""
    if name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            matches = [entry for entry in package.infolist() if entry.filename == member]
            if len(matches) != 1 or matches[0].is_dir() or stat.S_ISLNK(matches[0].external_attr >> 16) or not 0 < matches[0].file_size <= 268_435_456:
                raise RuntimeError("Runtime executable is invalid")
            with package.open(matches[0]) as source:
                content = source.read(268_435_457)
            if len(content) > 268_435_456 or not content.startswith(b"\x7fELF"):
                raise RuntimeError("Runtime executable exceeds its budget")
            binary = destination / "bun"
            binary.write_bytes(content); binary.chmod(0o755)
        return
    found, size = False, 0
    mode = "r|xz" if name.endswith(".xz") else "r|gz"
    with tarfile.open(fileobj=io.BytesIO(archive), mode=mode) as package:
        for count, entry in enumerate(package):
            size += max(entry.size, 512)
            if count >= 20_000 or size > 1_073_741_824 or entry.size < 0:
                raise RuntimeError("Runtime archive exceeds its budget")
            path = entry.name.removeprefix("./").rstrip("/")
            if member is not None:
                if path != member: continue
                if found or not entry.isfile(): raise RuntimeError("Runtime executable is ambiguous")
                relative = "gh"
                found = True
            else:
                if path == stem and entry.isdir(): continue
                if not path.startswith(stem + "/"): raise RuntimeError("Runtime archive prefix is invalid")
                relative = path[len(stem) + 1:]
            if not relative or relative.startswith("/") or any(part in {"", ".", ".."} for part in relative.split("/")):
                raise RuntimeError("Runtime archive path is unsafe")
            target = destination / relative
            if any(parent.is_symlink() for parent in target.parents):
                raise RuntimeError("Runtime archive path has an indirect parent")
            if target.exists() or target.is_symlink():
                # Directory entries may follow children in otherwise valid archives.
                if not (entry.isdir() and target.is_dir() and not target.is_symlink()):
                    raise RuntimeError("Runtime archive path is duplicated or indirect")
            if entry.mode & 0o7000: raise RuntimeError("Runtime archive has special permissions")
            target.parent.mkdir(parents=True, exist_ok=True)
            if entry.isdir():
                target.mkdir(exist_ok=True); target.chmod(0o755)
            elif entry.issym():
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), entry.linkname))
                if member is not None or entry.linkname.startswith("/") or resolved == ".." or resolved.startswith("../"):
                    raise RuntimeError("Runtime archive link escapes its tree")
                target.symlink_to(entry.linkname)
            elif entry.isfile():
                source = package.extractfile(entry)
                if source is None: raise RuntimeError("Runtime archive file is missing")
                with source, target.open("xb") as output:
                    while chunk := source.read(65_536): output.write(chunk)
                target.chmod(0o755 if entry.mode & 0o111 else 0o644)
            else:
                raise RuntimeError("Runtime archive contains unsupported special files")
    if member is not None and not found: raise RuntimeError("Runtime archive executable is missing")


def runtime_link(path, target, expected):
    """Select a runtime through one fenced symlink, leaving versioned installations intact."""
    current = os.readlink(path) if path.is_symlink() else None
    if (path.exists() and not path.is_symlink()) or current != expected:
        raise RuntimeError("Runtime default link changed")
    with tempfile.TemporaryDirectory(prefix=".homelab-runtime-link-", dir=path.parent) as temporary:
        link = Path(temporary) / "link"
        link.symlink_to(target)
        if (path.exists() and not path.is_symlink()) or (os.readlink(path) if path.is_symlink() else None) != expected:
            raise RuntimeError("Runtime default link changed")
        os.replace(link, path)


def toolchain_install(recipe, installed, candidate, run, emit, replace, lock):
    """Install beside pinned runtimes and switch only the explicitly owned default references."""
    application = recipe["application"]
    directory = Path(recipe["directory"])
    inventory = native_file(recipe["inventory"])
    for path in (directory, inventory, *[Path(link["path"]).parent for link in recipe.get("links", [])]):
        value = path.stat()
        if path.resolve() != path or value.st_uid != os.geteuid() or value.st_mode & 0o022:
            raise RuntimeError("Runtime configuration ownership changed")
    if inventory.stat().st_size > 65_536: raise RuntimeError("Runtime inventory exceeds its budget")
    binary_name = "bin/node" if application == "node" else "bun" if application == "bun" else "gh"
    with lock(directory):
        original_inventory = inventory.read_bytes()
        settings = json.loads(original_inventory)
        configured = Path(settings["executables"][application])
        previous = configured.resolve()
        if previous != directory / installed / binary_name or native_version(run([str(configured), "--version"])) != installed:
            raise RuntimeError("Runtime selection changed")
        links = []
        for link in recipe.get("links", []):
            path = Path(link["path"])
            old = os.readlink(path) if path.is_symlink() else None
            if (path.exists() and not path.is_symlink()) or (old is not None and path.resolve() != (directory / installed / link["member"]).resolve()):
                raise RuntimeError("Runtime entrypoint is not owned by this installation")
            links.append((path, old, directory / candidate / link["member"]))
        wrapper = native_file(recipe["wrapper"]) if recipe.get("wrapper") else None
        original_wrapper = wrapper.read_bytes() if wrapper else None
        if wrapper and (wrapper.stat().st_uid != os.geteuid() or wrapper.stat().st_mode & 0o022 or len(original_wrapper) > 16_384 or original_wrapper.count(str(previous).encode()) != 1):
            raise RuntimeError("Runtime wrapper reference is not unambiguous")
        architecture = run(["/usr/bin/uname", "-m"])
        if architecture not in {"x86_64", "aarch64"}: raise RuntimeError("Unsupported runtime architecture")
        emit("downloading")
        archive, name, stem, member, digest = runtime_archive(application, candidate, architecture)
        destination = directory / candidate
        identity = {"application": application, "version": candidate, "sha256": digest}
        if destination.exists():
            marker = native_file(str(destination / ".homelab-release.json"))
            if destination.is_symlink() or destination.stat().st_uid != os.geteuid() or destination.stat().st_mode & 0o022 or marker.stat().st_uid != os.geteuid() or marker.stat().st_mode & 0o022 or marker.stat().st_size > 4096 or json.loads(marker.read_text()) != identity:
                raise RuntimeError("Existing runtime version requires qualification")
        else:
            with tempfile.TemporaryDirectory(prefix=".homelab-runtime-", dir=directory) as temporary:
                staged = Path(temporary) / "release"
                staged.mkdir()
                extract_runtime(archive, name, stem, member, staged)
                if native_version(run([str(staged / binary_name), "--version"])) != candidate:
                    raise RuntimeError("Runtime artifact version differs from approval")
                (staged / ".homelab-release.json").write_text(json.dumps(identity))
                staged.chmod(0o755)
                if destination.exists(): raise RuntimeError("Runtime version appeared during preparation")
                os.rename(staged, destination)
        if native_version(run([str(destination / binary_name), "--version"])) != candidate or inventory.read_bytes() != original_inventory:
            raise RuntimeError("Runtime selection changed during preparation")
        updated_wrapper = original_wrapper.replace(str(previous).encode(), str(destination / binary_name).encode()) if wrapper else None
        settings["executables"][application] = str(destination / binary_name)
        updated_inventory = (json.dumps(settings, indent=2) + "\n").encode()
        changed = []
        try:
            emit("installing")
            if wrapper: replace(wrapper, updated_wrapper, original_wrapper)
            for path, old, target in links:
                runtime_link(path, target, old)
                changed.append((path, old, target))
            replace(inventory, updated_inventory, original_inventory)
            if native_version(run([str(destination / binary_name), "--version"])) != candidate:
                raise RuntimeError("Runtime activation could not be verified")
        except Exception:
            # Restore only references still owned by this attempt. Never remove a
            # versioned runtime: a pinned project may already reference that path.
            if inventory.read_bytes() == updated_inventory: replace(inventory, original_inventory, updated_inventory)
            for path, old, target in reversed(changed):
                if path.is_symlink() and os.readlink(path) == str(target):
                    if old is None: path.unlink()
                    else: runtime_link(path, old, str(target))
            if wrapper and wrapper.read_bytes() == updated_wrapper: replace(wrapper, original_wrapper, updated_wrapper)
            raise
        return False
