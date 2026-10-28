"""Publish only the already qualified Windows assets; never replace existing bytes."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def file_digest(path):
    """Return a streamed SHA-256 digest for a bounded ordinary release artifact."""
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 512 * 1024 * 1024:
        raise ValueError("Invalid computer release asset")
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def qualified_assets(directory, tag, revision):
    """Bind passive downloaded assets to this stable release and exact source revision."""
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid release identity")
    stem = f"mira-computer-{tag[1:]}-windows-x64"
    archive, manifest, installer = directory / (stem + ".zip"), directory / (stem + ".json"), directory / (stem + "-setup.exe")
    if directory.is_symlink() or sorted(item.name for item in directory.iterdir()) != sorted([archive.name, manifest.name, installer.name]):
        raise ValueError("Unexpected computer release assets")
    file_digest(manifest)
    if manifest.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Computer manifest is too large")
    metadata = json.loads(manifest.read_text(encoding="utf-8"))
    if (metadata.get("schemaVersion"), metadata.get("platform"), metadata.get("version"), metadata.get("revision")) != (1, "windows-x64", tag[1:], revision):
        raise ValueError("Computer release identity mismatch")
    if metadata.get("archive") != {"name": archive.name, "size": archive.stat().st_size, "sha256": file_digest(archive)}:
        raise ValueError("Computer release digest mismatch")
    if metadata.get("installer") != {"name": installer.name, "size": installer.stat().st_size, "sha256": file_digest(installer)}:
        raise ValueError("Computer installer digest mismatch")
    return archive, manifest, installer


def publish(directory, tag, revision):
    """Upload missing assets, accepting a retry only if every existing asset is byte-identical."""
    assets = qualified_assets(directory, tag, revision)
    release = json.loads(subprocess.check_output(["gh", "release", "view", tag, "--json", "tagName,isDraft,isPrerelease,assets"], text=True))
    if release["tagName"] != tag or release["isDraft"] or release["isPrerelease"]:
        raise ValueError("Only a published stable release can receive the computer package")
    existing = {asset["name"] for asset in release["assets"]}
    # Validate all existing assets before adding anything; never use --clobber.
    with tempfile.TemporaryDirectory(prefix="mira-published-assets-") as temporary:
        for asset in assets:
            if asset.name in existing:
                subprocess.run(["gh", "release", "download", tag, "--pattern", asset.name, "--dir", temporary], check=True)
                if file_digest(Path(temporary) / asset.name) != file_digest(asset):
                    raise ValueError("Published computer asset differs; refusing replacement")
        missing = [str(asset) for asset in assets if asset.name not in existing]
        if missing:
            subprocess.run(["gh", "release", "upload", tag, *missing], check=True)


if __name__ == "__main__":
    publish(Path(os.environ["COMPUTER_RELEASE_DIRECTORY"]), os.environ["RELEASE_TAG"], os.environ["SOURCE_SHA"])
