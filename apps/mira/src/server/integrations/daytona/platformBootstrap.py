"""Release-built bootstrap for the fixed Homelab profile in a fresh Daytona Linux sandbox."""

import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Unexpected redirect from the pinned Bun package")


def pinned_bun(directory, version, integrity):
    url = f"https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-{version}.tgz"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())
    with tempfile.TemporaryFile(dir=directory) as compressed:
        digest = hashlib.sha512()
        total = 0
        with opener.open(url, timeout=20) as response:
            if response.status != 200 or response.geturl() != url:
                raise ValueError("Unexpected response for pinned Bun")
            while chunk := response.read(256 * 1024):
                total += len(chunk)
                if total > 96 * 1024 * 1024:
                    raise ValueError("Bun package exceeded its size limit")
                digest.update(chunk)
                compressed.write(chunk)
        if digest.digest() != base64.b64decode(integrity, validate=True):
            raise ValueError("Bun package integrity mismatch")
        compressed.seek(0)
        with tarfile.open(fileobj=compressed, mode="r:gz") as archive:
            binary = archive.getmember("package/bin/bun")
            if not binary.isreg() or not 1 <= binary.size <= 256 * 1024 * 1024:
                raise ValueError("Unexpected Bun binary")
            with archive.extractfile(binary) as source, (directory / "bun").open("xb") as target:
                remaining = binary.size
                while remaining:
                    chunk = source.read(min(remaining, 256 * 1024))
                    if not chunk:
                        raise ValueError("Truncated Bun binary")
                    remaining -= len(chunk)
                    target.write(chunk)
    (directory / "bun").chmod(0o500)


def main():
    if (os.geteuid() == 0 or sys.platform != "linux" or platform.machine() != "x86_64"
            or not os.confstr("CS_GNU_LIBC_VERSION")):
        raise ValueError("A non-root glibc Linux x86_64 sandbox is required")
    run_id = sys.argv[1]
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", run_id):
        raise ValueError("Invalid attempt ID")
    os.umask(0o077)
    attempt = Path("/tmp/homelab-mira") / run_id
    if attempt.resolve(strict=True) != attempt or attempt.stat().st_uid != os.geteuid():
        raise ValueError("Unexpected sandbox attempt")
    tools = attempt / "tools"
    tools.mkdir(mode=0o700)
    version, integrity, bundle = json.loads(base64.b64decode("__HOMELAB_RELEASE_PAYLOAD__", validate=True))
    profile = json.loads(base64.b64decode("__HOMELAB_RELEASE_PROFILE__", validate=True))
    if profile["bunVersion"] != version:
        raise ValueError("Check profile and Bun lockfile disagree")
    program = gzip.decompress(base64.b64decode(bundle, validate=True))
    if not 1 <= len(program) <= 512 * 1024:
        raise ValueError("Unexpected check harness size")
    harness = tools / "daytona-check.js"
    harness.write_bytes(program)
    harness.chmod(stat.S_IRUSR)
    (tools / "profile.json").write_text(json.dumps(profile, separators=(",", ":")), encoding="utf8")
    pinned_bun(tools, profile["bunVersion"], integrity)
    bun = str(tools / "bun")
    env = {"PATH": f"{tools}:/usr/local/bin:/usr/bin:/bin", "HOME": str(attempt),
           "LANG": "C.UTF-8", "HOMELAB_MIRA_SANDBOX_PROFILE": "homelab-check-v2"}
    revision = subprocess.run([bun, "--no-env-file", "-e", "process.stdout.write(Bun.revision)"],
                              cwd=tools, env=env, capture_output=True, check=True, timeout=10)
    if revision.stdout.decode("ascii") != profile["bunRevision"]:
        raise ValueError("Bun revision mismatch")
    os.chdir(tools)
    os.execve(bun, [bun, "--no-env-file", str(harness), *sys.argv[1:]], env)


main()
