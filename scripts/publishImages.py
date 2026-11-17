"""Publish three built images under the roles understood by installed updaters."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def publish(local, roles, repository, version, revision):
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
    references = []
    for role in roles:
        tag = f"ghcr.io/{repository}/{role}:{version}"
        existing = subprocess.run(["docker", "manifest", "inspect", tag], capture_output=True, text=True)
        if existing.returncode == 0:
            if json.loads(existing.stdout).get("config", {}).get("digest") != digest:
                raise ValueError("Published release image differs; refusing replacement")
        else:
            if not any(reason in existing.stderr for reason in ["manifest unknown", "no such manifest", "NAME_UNKNOWN"]):
                raise ValueError("Cannot verify registry state")
            subprocess.run(["docker", "tag", local, tag], check=True)
            subprocess.run(["docker", "push", tag], check=True)
        remote = json.loads(run("docker", "manifest", "inspect", tag))
        if remote.get("config", {}).get("digest") != digest:
            raise ValueError("Published image config differs")
        subprocess.run(["docker", "pull", tag], check=True)
        prefix = f"ghcr.io/{repository}/{role}@sha256:"
        found = json.loads(run("docker", "image", "inspect", tag))[0]["RepoDigests"]
        reference = next(value for value in found if value.startswith(prefix))
        references.append({"app": role, "tag": tag, "reference": tag + "@" + reference.split("@", 1)[1]})
    return references, labels


def main():
    tag, revision = os.environ["RELEASE_TAG"], os.environ["SOURCE_SHA"]
    repository = os.environ["GH_REPO"].lower()
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid release identity")
    version = tag[1:]
    auth, auth_labels = publish("homelab-release/auth:built", ["auth"], repository, version, revision)
    main_images, labels = publish("homelab-release/homelab:built", ["dashboard", "mira", "mira-browser", "daytona-check"], repository, version, revision)
    proxy, _ = publish("homelab-release/mira-browser-proxy:built", ["mira-browser-proxy"], repository, version, revision)
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
