"""Capture the private X display through a real pipe, without an image file."""
import subprocess
import sys

if len(sys.argv) != 2 or sys.argv[1] not in ("png", "jpg"):
    raise SystemExit("Unsupported screenshot format")
with subprocess.Popen(
    ["/usr/bin/scrot", "--silent", "--format", sys.argv[1], "--quality", "80", "-"],
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
) as process:
    size = 0
    while chunk := process.stdout.read(65536):
        size += len(chunk)
        if size > 4 * 1024 * 1024:
            process.kill()
            raise SystemExit("Screenshot exceeds its bound")
        sys.stdout.buffer.write(chunk)
    sys.stdout.buffer.flush()
    if process.wait() != 0:
        raise SystemExit("Screenshot capture failed")
