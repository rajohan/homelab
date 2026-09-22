"""Bundled native installers. They share the worker's transient SSH interpreter.

Only deployment-owned recipes select executables or local paths. Published inventory
selects an exact stable version, never a command, download origin or service name.
"""
import hashlib
import gzip
import io
import os
from pathlib import Path
import re
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def native_download(url, limit):
    """Read bounded official metadata/artifacts with TLS and a restricted redirect chain."""
    def allowed(value):
        parsed = urllib.parse.urlsplit(value)
        return parsed.scheme == "https" and parsed.port in (None, 443) and not parsed.username and not parsed.password and parsed.hostname in {
            "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com",
            "updates.nextcloud.com", "api.github.com", "pypi.org", "files.pythonhosted.org", "nodejs.org",
        }
    class Redirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, file, code, message, headers, target):
            if not allowed(target):
                raise RuntimeError("Unexpected native download redirect")
            return super().redirect_request(request, file, code, message, headers, target)
    if not allowed(url):
        raise RuntimeError("Unexpected native download origin")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), Redirects())
    deadline = time.monotonic() + 240
    with opener.open(urllib.request.Request(url, headers={"User-Agent": "Homelab-Updater"}), timeout=30) as response:
        if response.status != 200 or int(response.headers.get("Content-Length", "0")) > limit:
            raise RuntimeError("Native download exceeded its budget")
        chunks, size = [], 0
        while True:
            chunk = response.read(min(65536, limit - size + 1))
            size += len(chunk)
            if size > limit or time.monotonic() > deadline:
                raise RuntimeError("Native download exceeded its budget")
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)


def native_version(output):
    """Accept one unambiguous numeric version, not unrelated runtime versions."""
    versions = set(re.findall(r"(?<![\d.])v?(\d+\.\d+\.\d+)(?![\d.\w-])", output))
    if len(versions) != 1:
        raise RuntimeError("Native version inspection is ambiguous")
    return versions.pop()


def native_file(path):
    """Reject missing, symlinked or unexpectedly indirect application files."""
    value = Path(path)
    if value.resolve() != value or not value.is_file() or value.is_symlink():
        raise RuntimeError("Native installation path changed")
    return value


def native_service(service, run):
    """Preserve whether an application was running; transitional states are not safe."""
    state = run(["/usr/bin/systemctl", "show", "--property=ActiveState", "--value", service])
    if state not in {"active", "inactive"}:
        raise RuntimeError("Native service is not in a stable state")
    return state == "active"


def adguard_install(recipe, installed, candidate, run, emit, replace, lock):
    """Verify an official archive and replace only the existing AdGuard Home binary."""
    binary = native_file(recipe["binary"])
    with lock(binary.parent):
        def metadata():
            value = binary.stat()
            # Replacing an inode would silently discard capabilities, ACLs and labels.
            # These installations require a separately qualified deployment recipe.
            if value.st_mode & 0o7000 or os.listxattr(binary, follow_symlinks=False):
                raise RuntimeError("AdGuard Home executable metadata requires deployment review")
            return value.st_ino, value.st_mode, value.st_uid, value.st_gid
        original_metadata = metadata()
        if binary.stat().st_size > 104_857_600:
            raise RuntimeError("AdGuard Home binary exceeds its budget")
        before = binary.read_bytes()
        if native_version(run([str(binary), "--version"])) != installed:
            raise RuntimeError("AdGuard Home version changed")
        active = native_service(recipe["service"], run)
        architecture = run(["/usr/bin/uname", "-m"])
        architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(architecture)
        if architecture is None:
            raise RuntimeError("Unsupported AdGuard Home architecture")
        name = "AdGuardHome_linux_" + architecture + ".tar.gz"
        base = "https://github.com/AdguardTeam/AdGuardHome/releases/download/v" + candidate + "/"
        emit("downloading")
        checksums = native_download(base + "checksums.txt", 1_048_576).decode("utf-8")
        hashes = [line.split()[0] for line in checksums.splitlines()
                  if len(line.split()) == 2 and line.split()[1].removeprefix("./").removeprefix("*") == name]
        if len(hashes) != 1 or not re.fullmatch(r"[a-f0-9]{64}", hashes[0]):
            raise RuntimeError("AdGuard Home checksum is unavailable")
        archive = native_download(base + name, 104_857_600)
        if hashlib.sha256(archive).hexdigest() != hashes[0]:
            raise RuntimeError("AdGuard Home archive checksum failed")
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as compressed:
            expanded = compressed.read(134_217_729)
        if len(expanded) > 134_217_728:
            raise RuntimeError("AdGuard Home expanded archive exceeds its budget")
        with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as package:
            members = [member for member in package.getmembers() if member.name.removeprefix("./") == "AdGuardHome/AdGuardHome"]
            if len(members) != 1 or not members[0].isfile() or not 0 < members[0].size <= 104_857_600:
                raise RuntimeError("AdGuard Home archive binary is invalid")
            stream = package.extractfile(members[0])
            if stream is None:
                raise RuntimeError("AdGuard Home archive binary is missing")
            with stream:
                contents = stream.read(104_857_601)
        # No archive paths are extracted. Stage one executable under a private temporary name.
        with tempfile.TemporaryDirectory(prefix=".homelab-native-", dir=binary.parent) as temporary:
            staged = Path(temporary) / "AdGuardHome"
            staged.write_bytes(contents)
            staged.chmod(0o700)
            if native_version(run([str(staged), "--version"])) != candidate:
                raise RuntimeError("AdGuard Home archive version differs from approval")
            if native_service(recipe["service"], run) != active or native_version(run([str(binary), "--version"])) != installed:
                raise RuntimeError("AdGuard Home changed during preparation")
            if metadata() != original_metadata:
                raise RuntimeError("AdGuard Home executable metadata changed during preparation")
            emit("installing")
            replace(binary, contents, before)
        if active:
            emit("restarting")
            run(["/usr/bin/systemctl", "restart", recipe["service"]])
        if native_version(run([str(binary), "--version"])) != candidate or native_service(recipe["service"], run) != active:
            raise RuntimeError("AdGuard Home activation failed")
        return active


def openclaw_install(recipe, installed, candidate, run, emit):
    """Run the exact-version updater offline; only reactivate a verified successful update."""
    base = recipe["command"]
    if native_version(run(base + ["--version"])) != installed:
        raise RuntimeError("OpenClaw version changed")
    active = native_service(recipe["service"], run)
    # --no-restart leaves lifecycle ownership here. Doctor needs the gateway's
    # state coordinator released before it can perform update maintenance.
    try:
        if active:
            emit("stopping_application")
            run(["/usr/bin/systemctl", "stop", recipe["service"]])
        if native_service(recipe["service"], run):
            raise RuntimeError("OpenClaw service did not stop")
    except Exception:
        raise UpdateRefusal("openclaw_stop_failed") from None
    try:
        emit("installing")
        run(base + ["update", "--tag", candidate, "--yes", "--no-restart"], timeout=1200)
        if native_version(run(base + ["--version"])) != candidate:
            raise RuntimeError("OpenClaw updater did not install the approved version")
    except Exception:
        # A package rollback alone does not prove Doctor/state recovery is safe.
        # Leave recovery to the operator instead of booting a partial update.
        raise UpdateRefusal("openclaw_update_failed") from None
    if active:
        emit("restarting")
        run(["/usr/bin/systemctl", "start", recipe["service"]])
    if native_service(recipe["service"], run) != active:
        raise RuntimeError("OpenClaw activation failed")
    return active


def nextcloud_install(recipe, installed, candidate, run, emit, lock):
    """Delegate signed code/DB updates to Nextcloud, pinning the vendor-approved archive."""
    import json
    directory = Path(recipe["directory"])
    version_file = native_file(str(directory / "version.php"))
    updater = native_file(str(directory / "updater/updater.phar"))
    base = ["/usr/sbin/runuser", "-u", recipe["user"], "--", recipe["php"]]
    occ = base + [str(directory / "occ")]
    def status():
        value = json.loads(run(occ + ["status", "--output=json"]))
        if not value.get("installed") or value.get("maintenance") or value.get("needsDbUpgrade"):
            raise RuntimeError("Nextcloud requires maintenance recovery before updating")
        return value
    with lock(directory):
        # Capabilities vary independently of the server version. Never run a legacy
        # updater unpinned or disable signature verification as a fallback.
        help_text = run(base + [str(updater), "--help"])
        for option in ("url", "signature", "no-backup", "no-interaction"):
            # Symfony renders optional values as --url[=URL], required values
            # as --url=URL, and flags without a value. Keep exact option boundaries.
            if not re.search(r"(?m)^\s+(?:-[a-zA-Z],\s*)?--" + option + r"(?:\[?=|\s|$)", help_text):
                raise RuntimeError("Installed Nextcloud updater does not support exact signed upgrades")
        if status().get("versionstring") != installed:
            raise RuntimeError("Nextcloud version changed")
        if json.loads(run(occ + ["integrity:check-core", "--output=json"])) not in ({}, []):
            raise RuntimeError("Nextcloud core changes require review before updating")
        # Do not resume a previous partially completed updater invocation implicitly.
        data = run(occ + ["config:system:get", "datadirectory"])
        update_directory = run(occ + ["config:system:get", "updatedirectory", "--default-value=" + data])
        instance = run(occ + ["config:system:get", "instanceid"])
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", instance) or (Path(update_directory) / ("updater-" + instance) / ".step").exists():
            raise RuntimeError("Nextcloud has an unfinished update")
        text = version_file.read_text()
        version = re.search(r"\$OC_Version\s*=\s*array\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)", text)
        build = re.search(r"\$OC_Build\s*=\s*'([^']*)'", text)
        php = run([recipe["php"], "-r", "echo PHP_MAJOR_VERSION.'x'.PHP_MINOR_VERSION.'x'.PHP_RELEASE_VERSION;"])
        if not version or not build or not re.fullmatch(r"\d+x\d+x\d+", php):
            raise RuntimeError("Nextcloud release metadata is unavailable")
        if ".".join(version.groups()[:3]) != installed or int(candidate.split(".")[0]) not in {int(version[1]), int(version[1]) + 1}:
            raise RuntimeError("Nextcloud upgrades cannot skip a major release")
        query = "x".join(version.groups()) + "xxxstablexx" + build[1] + "x" + php
        emit("downloading")
        body = native_download("https://updates.nextcloud.com/updater_server/?version=" + urllib.parse.quote(query, safe=""), 1_048_576)
        if b"<!" in body:
            raise RuntimeError("Unexpected Nextcloud release metadata")
        feed = ET.fromstring(body)
        offered = feed.findtext("version", "")
        expected_url = "https://download.nextcloud.com/server/releases/nextcloud-" + candidate + ".zip"
        urls = [feed.findtext("url", "")] + [entry.text for entry in feed.findall("downloads/zip/*")] + [feed.findtext("downloads/zip", "")]
        # The official feed wraps base64 signatures across lines. Whitespace is
        # transport formatting; the updater still verifies the complete signature.
        signature = re.sub(r"[ \t\r\n]", "", feed.findtext("signature", ""))
        if offered.split(".")[:3] != candidate.split(".") or feed.findtext("autoupdater") != "1" or expected_url not in urls or not re.fullmatch(r"[A-Za-z0-9+/]{100,2000}={0,2}", signature):
            raise RuntimeError("Nextcloud does not offer this exact signed upgrade for the installation")
        if status().get("versionstring") != installed:
            raise RuntimeError("Nextcloud changed during preparation")
        emit("installing")
        # PBS is the backup system. Do not create an unrelated local backup or skip signatures.
        run(base + [str(updater), "--no-interaction", "--no-backup", "--url=" + expected_url, "--signature=" + signature], timeout=1200)
        emit("verifying")
        if status().get("versionstring") != candidate:
            raise RuntimeError("Nextcloud code and database upgrade did not complete")
        return True


def install_native_recipe(driver, item, run, emit, replace, lock):
    """Apply one typed native recipe and return only a verified exact-version receipt."""
    recipe = driver["recipe"]
    installed, candidate = item["installed"].removeprefix("v"), item["available"].removeprefix("v")
    if not all(re.fullmatch(r"\d+\.\d+\.\d+", value) for value in (installed, candidate)) or tuple(map(int, candidate.split("."))) <= tuple(map(int, installed.split("."))):
        raise RuntimeError("Native recipes require an exact stable upgrade")
    if driver["release"] != recipe["application"] or item.get("release") != driver["release"]:
        raise RuntimeError("Native recipe release provider changed")
    application = recipe["application"]
    if application == "adguard-home":
        active = adguard_install(recipe, installed, candidate, run, emit, replace, lock)
    elif application == "openclaw":
        active = openclaw_install(recipe, installed, candidate, run, emit)
    elif application == "nextcloud":
        active = nextcloud_install(recipe, installed, candidate, run, emit, lock)
    elif application == "codex":
        active = codex_install(recipe, installed, candidate, run, emit, lock)
    elif application == "pve-exporter":
        active = python_application_install(recipe, installed, candidate, run, emit, lock)
    elif application in {"bun", "node", "github-cli"}:
        active = toolchain_install(recipe, installed, candidate, run, emit, replace, lock, lambda: run(driver["health"]))
    elif application in BINARY_RELEASES:
        active = binary_install(recipe, installed, candidate, run, emit, replace, lock)
    else:
        raise RuntimeError("Unsupported native recipe")
    emit("verifying")
    if active:
        if application in {"loki", "openclaw"}:
            # An active service can still be starting. Retry only the read-only
            # health probe for these recipes, never installation or restart.
            deadline = time.monotonic() + 60
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise UpdateRefusal(application + "_readiness_failed")
                try:
                    run(driver["health"], timeout=min(10, remaining))
                    break
                except RuntimeError as error:
                    if str(error) not in {"Update command failed", "Command deadline exceeded"}:
                        raise
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise UpdateRefusal(application + "_readiness_failed") from None
                    time.sleep(min(2, remaining))
        else:
            run(driver["health"])
    return item["available"]
