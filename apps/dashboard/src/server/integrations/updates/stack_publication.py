"""Durable public image-pin receipts for the opted-in Homelab Compose stacks."""
import json
import os
from pathlib import Path
import re
import secrets
import time


PIN_QUEUE = Path("/var/spool/homelab-stack-pins")
STACK_PINS = {
    "homelab-services": {
        "aiometadata": "ghcr.io/cedya77/aiometadata", "aiostreams": "ghcr.io/viren070/aiostreams",
        "bitmagnet": "ghcr.io/bitmagnet-io/bitmagnet", "comet": "ghcr.io/g0ldyy/comet",
        "crosswatch": "ghcr.io/cenodude/crosswatch", "flaresolverr": "ghcr.io/thephaseless/byparr",
        "gluetun": "docker.io/qmcgaw/gluetun", "gost": "docker.io/gogost/gost",
        "jackett": "docker.io/linuxserver/jackett", "mediaflow": "docker.io/mhdzumair/mediaflow-proxy",
        "submaker": "docker.io/xtremexq/submaker", "valkey-cache": "docker.io/valkey/valkey",
        "valkey-submaker": "docker.io/valkey/valkey",
    },
    "homelab-tools": {
        "it-tools": "ghcr.io/corentinth/it-tools", "openspeedtest": "docker.io/openspeedtest/latest",
        "shlink": "ghcr.io/shlinkio/shlink", "shlink-web": "docker.io/shlinkio/shlink-web-client",
        "valkey-shlink": "docker.io/valkey/valkey",
    },
}


def public_pin(repo, service, image):
    """Validate the public upstream, stable channel/tag and immutable digest; return the canonical pin."""
    upstream = STACK_PINS[repo][service]
    if not isinstance(image, str) or len(image) > 300:
        raise ValueError("Invalid image reference")
    if not image.startswith(("docker.io/", "ghcr.io/")):
        image = "docker.io/" + image
    tag = r"(?::(?:latest|v?\d+(?:\.\d+){1,3}(?:-(?:ls\d+|alpine[\d.]*|bookworm|bullseye|trixie|slim))?))?"
    if not re.fullmatch(re.escape(upstream) + tag + r"@sha256:[a-f0-9]{64}", image):
        raise ValueError("Unreviewed public image reference")
    return image


def prepare_stack_pin(driver, previous, image):
    """Stage only allowed public metadata before changing a container; delivery needs final verification."""
    if not PIN_QUEUE.exists():
        return None
    directory = Path(driver["directory"])
    repo = {Path("/srv/workspaces/stremio"): "homelab-services",
            Path("/srv/workspaces/homelab-services"): "homelab-services",
            Path("/srv/workspaces/homelab-tools"): "homelab-tools",
            Path("/srv/workspaces/tools"): "homelab-tools"}.get(directory)
    if not repo:
        return None
    service = driver["service"]
    expected_project = "stremio" if repo == "homelab-services" else "tools"
    if driver["project"] != expected_project or Path(driver["imageFile"]) != directory/"apps"/service/"compose.yaml":
        raise ValueError("Unreviewed publication source")
    row = {"repository": repo, "service": service, "previous": public_pin(repo, service, previous),
           "image": public_pin(repo, service, image)}
    name = f"{time.time_ns():020d}-{secrets.token_hex(8)}"
    fd = os.open(PIN_QUEUE, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
    try:
        out = os.open(name+".prepared", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=fd)
        with os.fdopen(out, "w") as stream:
            os.fchmod(stream.fileno(), 0o644)
            json.dump(row, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.fsync(fd)
    finally:
        os.close(fd)
    return name


def finish_stack_pin(name, verified):
    """Publish the receipt atomically after verification or remove the reservation on handled failure."""
    if name is None:
        return
    fd = os.open(PIN_QUEUE, os.O_DIRECTORY | os.O_NOFOLLOW | os.O_RDONLY)
    try:
        if verified:
            os.rename(name+".prepared", name+".json", src_dir_fd=fd, dst_dir_fd=fd)
        else:
            os.unlink(name+".prepared", dir_fd=fd)
        os.fsync(fd)
    finally:
        os.close(fd)
