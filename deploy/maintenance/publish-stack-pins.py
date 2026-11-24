"""Publish verified public Compose image pins as Mira. Local Compose files never leave the host."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

from stack_publication import PIN_QUEUE, public_pin


def github(*args, payload=None):
    command = ["/usr/local/bin/gh", "api", "--hostname", "github.com", *args]
    if payload is not None:
        command.extend(["--input", "-"])
    result = subprocess.run(command, input=json.dumps(payload) if payload else None,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            timeout=45, check=True)
    return json.loads(result.stdout)


def read_receipt(receipt):
    fd = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r") as stream:
        mode = os.fstat(fd)
        if not stat.S_ISREG(mode.st_mode) or mode.st_size > 1024:
            raise ValueError("Invalid receipt")
        row = json.load(stream)
    if set(row) != {"repository", "service", "previous", "image"}:
        raise ValueError("Unexpected receipt fields")
    repo, service = row["repository"], row["service"]
    return repo, service, public_pin(repo, service, row["previous"]), public_pin(repo, service, row["image"])


def publish(repo, service, previous, candidate):
    path = f"repos/rajohan/{repo}/contents/apps/{service}/compose.yaml"
    source = github(path + "?ref=main")
    if source.get("type") != "file" or source.get("encoding") != "base64" or source["size"] > 4096:
        raise ValueError("Unsupported public base")
    contents = base64.b64decode(source["content"]).decode("utf-8")
    matches = list(re.finditer(r"(?m)^    image: ([^\s]+)$", contents))
    if len(matches) != 1 or not contents.startswith(f"services:\n  {service}:\n"):
        raise ValueError("Ambiguous public service")
    match = matches[0]
    current = public_pin(repo, service, match[1])
    if current != candidate:
        if current != previous:
            raise ValueError("Public pin was independently changed")
        updated = contents[:match.start(1)] + candidate + contents[match.end(1):]
        # All bytes except this validated image come from the existing public file.
        # The blob SHA makes parallel host/human changes a conflict instead of overwriting them.
        github("-X", "PUT", path, payload={
            "message": f"Update {service} image pin", "branch": "main", "sha": source["sha"],
            "content": base64.b64encode(updated.encode()).decode("ascii"),
        })


def main():
    queue_fd = os.open(PIN_QUEUE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(queue_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        files = sorted(PIN_QUEUE.iterdir())
        ready = [p for p in files if re.fullmatch(r"\d{20}-[0-9a-f]{16}\.json", p.name)]
        uncertain = any(p.suffix == ".prepared" and time.time()-p.lstat().st_mtime > 1800 for p in files)
        if uncertain:
            print("An installation did not record final verification. Review its prepared pin receipt.", file=sys.stderr)
        if ready and github("user").get("login") != "mira-2026":
            raise RuntimeError("The host GitHub account must be Mira")
        failed = False
        blocked = set()
        for receipt in ready:
            key = None
            try:
                repo, service, previous, candidate = read_receipt(receipt)
                key = (repo, service)
                if key in blocked:
                    continue
                publish(repo, service, previous, candidate)
                receipt.unlink()
                os.fsync(queue_fd)
                print(f"Published {repo}/{service}", flush=True)
            except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
                print(f"Retained {receipt.name} for retry. Check Mira access, the receipt and the public pin.", file=sys.stderr)
                failed = True
                # Never advance beyond an unpublished predecessor, including after a timed-out PUT.
                if key is None:
                    break
                blocked.add(key)
        return int(failed or uncertain)
    finally:
        os.close(queue_fd)


if __name__ == "__main__":
    sys.exit(main())
