"""Publish three built images and their logical release-manifest roles."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import time


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def inspect_manifest(tag, *, wait_for_publication=False):
    """Read the registry, briefly tolerating a missing manifest after a confirmed push."""
    attempts = 6 if wait_for_publication else 1
    for attempt in range(attempts):
        result = subprocess.run(["docker", "manifest", "inspect", tag], capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if not any(reason in result.stderr for reason in ["manifest unknown", "no such manifest", "NAME_UNKNOWN"]):
            raise ValueError("Cannot verify registry state")
        if attempt + 1 < attempts:
            print("Published manifest is not visible yet; retrying the registry read.", flush=True)
            time.sleep(2 ** attempt)
    return None


def publish(local, package, roles, repository, version, revision):
    metadata = json.loads(run("docker", "image", "inspect", local))[0]
    labels = metadata["Config"].get("Labels", {})
    expected_user = "0:0" if roles == ["mira-browser-proxy"] else "bun"
    if (metadata["Config"]["User"] != expected_user or
            labels.get("org.opencontainers.image.version") != version or
            labels.get("org.opencontainers.image.revision") != revision or
            labels.get("org.opencontainers.image.source", "").lower() != "https://github.com/" + repository):
        raise ValueError("Built image identity does not match release")
    # Hash the saved image config: this works with both Docker image stores.
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / "image.tar"
        subprocess.run(["docker", "save", "--output", str(archive), local], check=True)
        with tarfile.open(archive) as image:
            manifest = json.load(image.extractfile("manifest.json"))
            config = next(entry["Config"] for entry in manifest if local in entry["RepoTags"])
            digest = "sha256:" + hashlib.sha256(image.extractfile(config).read()).hexdigest()
    tag = f"ghcr.io/{repository}/{package}:{version}"
    existing = inspect_manifest(tag)
    if existing is not None:
        if existing.get("config", {}).get("digest") != digest:
            raise ValueError("Published release image differs; refusing replacement")
        remote = existing
    else:
        subprocess.run(["docker", "tag", local, tag], check=True)
        subprocess.run(["docker", "push", tag], check=True)
        remote = inspect_manifest(tag, wait_for_publication=True)
        if remote is None:
            raise ValueError("Published manifest did not become visible; inspect the registry before retrying publication")
    if remote.get("config", {}).get("digest") != digest:
        raise ValueError("Published image config differs")
    subprocess.run(["docker", "pull", tag], check=True)
    prefix = f"ghcr.io/{repository}/{package}@sha256:"
    found = json.loads(run("docker", "image", "inspect", tag))[0]["RepoDigests"]
    reference = next(value for value in found if value.startswith(prefix))
    references = [{"app": role, "tag": tag, "reference": tag + "@" + reference.split("@", 1)[1]} for role in roles]
    return references, labels


def main():
    tag, revision = os.environ["RELEASE_TAG"], os.environ["SOURCE_SHA"]
    repository = os.environ["GH_REPO"].lower()
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid release identity")
    version = tag[1:]
    auth, auth_labels = publish("homelab-release/auth:built", "auth", ["auth"], repository, version, revision)
    main_images, labels = publish("homelab-release/homelab:built", "dashboard", ["dashboard", "mira", "mira-browser", "daytona-check"], repository, version, revision)
    proxy, _ = publish("homelab-release/mira-browser-proxy:built", "mira-browser-proxy", ["mira-browser-proxy"], repository, version, revision)
    schemas = {"dashboardSchema": labels.get("io.homelab.dashboard-schema"), "authSchema": auth_labels.get("io.homelab.auth-schema")}
    if not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) for value in schemas.values()):
        raise ValueError("Missing migration fingerprints")
    common = {"version": version, "revision": revision, "platform": "linux/amd64"}
    manifests = {
        "container": {**common, **schemas, "images": auth + main_images[:2]},
        "browser": {**common, "images": [main_images[2], *proxy]},
        "daytona": {**common, "images": [main_images[3]]},
    }
    for kind, manifest in manifests.items():
        filename = "container-images.json" if kind == "container" else kind + "-image.json"
        evidence = "release" if kind == "container" else kind
        content = json.dumps(manifest, indent=2) + "\n"
        Path(filename).write_text(content)
        Path(f"{evidence}-manifest-{os.environ['GITHUB_RUN_ATTEMPT']}.json").write_text(content)
        subprocess.run(["gh", "release", "upload", tag, filename, "--clobber"], check=True)


if __name__ == "__main__":
    main()
