"""Relay one private Docker exec stream to x11vnc's required duplex inetd socket."""
import os
import socket
import subprocess
import sys
import threading

if len(sys.argv) != 2 or sys.argv[1] not in ("view", "input", "control"):
    raise SystemExit(2)

parent, child = socket.socketpair()
arguments = [
    "/usr/bin/x11vnc", "-inetd", "-display", ":99",
    "-auth", "/tmp/mira-browser.xauth", "-quiet", "-nosel", "-noremote", "-xkb",
]
if sys.argv[1] == "view":
    arguments.extend(["-viewonly", "-nocursorshape"])
elif sys.argv[1] == "input":
    arguments.append("-nofb")
process = subprocess.Popen(
    arguments, stdin=child, stdout=child, stderr=subprocess.DEVNULL, close_fds=True
)
child.close()

def receive():
    """Forward client input; EOF revokes the input process immediately."""
    try:
        while data := os.read(0, 65536):
            parent.sendall(data)
    except OSError:
        pass
    finally:
        process.terminate()

threading.Thread(target=receive, daemon=True).start()
try:
    while data := parent.recv(65536):
        remaining = memoryview(data)
        while remaining:
            remaining = remaining[os.write(1, remaining):]
except OSError:
    pass
finally:
    parent.close()
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
