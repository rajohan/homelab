"""Synthetic HTTP/TLS/DNS endpoints and probes for an isolated Docker-only network."""
import http.server
import json
import os
import socket
import socketserver
import ssl
import struct
import subprocess
import sys
import threading
import urllib.error
import urllib.request

state = {"privateHits": 0, "flipped": False, "dns": 0}

class Site(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        """Serve bounded synthetic responses and count access to the private interface."""
        if self.connection.getsockname()[0] == os.environ.get("PRIVATE_IP"):
            state["privateHits"] += 1
        if self.path == "/_flip":
            state["flipped"] = True
        if self.path == "/redirect-private":
            self.send_response(302)
            self.send_header("Location", "http://" + os.environ["PRIVATE_IP"] + "/forbidden")
            self.end_headers()
            return
        body = json.dumps(state).encode() if self.path.startswith("/_") else b"<html><title>Mira isolated fixture</title><h1>Public synthetic website</h1><input aria-label='Fixture text'><button onclick=\"this.textContent='Clicked 1'\">Count</button></html>"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        """Keep request content out of qualification logs."""

class DNS(socketserver.BaseRequestHandler):
    def handle(self):
        """Return zero-TTL controlled answers, including a public-to-private rebinding case."""
        data, transport = self.request
        if len(data) < 17:
            return
        offset, labels = 12, []
        while offset < len(data) and data[offset]:
            length = data[offset]
            if length > 63 or offset + 1 + length > len(data):
                return
            labels.append(data[offset + 1:offset + 1 + length].decode("ascii"))
            offset += 1 + length
        offset += 1
        if offset + 4 > len(data):
            return
        kind = struct.unpack("!H", data[offset:offset + 2])[0]
        name = ".".join(labels).lower()
        state["dns"] += 1
        public, private = os.environ["PUBLIC_IP"], os.environ["PRIVATE_IP"]
        addresses = []
        if kind == 1:
            if name == "public.mira.test":
                addresses = [public]
            elif name == "private.mira.test":
                addresses = [private]
            elif name == "mixed.mira.test":
                addresses = [public, private]
            elif name == "flip.mira.test":
                addresses = [private if state["flipped"] else public]
        answers = b"".join(b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 0, 4) + socket.inet_aton(address) for address in addresses)
        response = data[:2] + struct.pack("!HHHHH", 0x8180, 1, len(addresses), 0, 0) + data[12:offset + 4] + answers
        transport.sendto(response, self.client_address)

def serve():
    """Start actual DNS, HTTP and TLS on the disposable fixture only."""
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=public.mira.test", "-keyout", "/tmp/key.pem", "-out", "/tmp/cert.pem"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    dns = socketserver.ThreadingUDPServer(("0.0.0.0", 53), DNS)
    threading.Thread(target=dns.serve_forever, daemon=True).start()
    http_server = http.server.ThreadingHTTPServer(("0.0.0.0", 80), Site)
    threading.Thread(target=http_server.serve_forever, daemon=True).start()
    https = http.server.ThreadingHTTPServer(("0.0.0.0", 443), Site)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain("/tmp/cert.pem", "/tmp/key.pem")
    https.socket = context.wrap_socket(https.socket, server_side=True)
    https.serve_forever()

def probe():
    """Probe one URL with an explicit optional proxy and return only status/body evidence."""
    proxy, url = sys.argv[2:]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({} if proxy == "direct" else {"http": proxy, "https": proxy}), urllib.request.HTTPSHandler(context=ssl._create_unverified_context()))
    try:
        with opener.open(url, timeout=2) as response:
            print(json.dumps({"status": response.status, "body": response.read(4096).decode()}))
    except urllib.error.HTTPError as error:
        print(json.dumps({"status": error.code}))
    except (urllib.error.URLError, TimeoutError, OSError):
        print(json.dumps({"status": "blocked"}))

if sys.argv[1] == "serve":
    serve()
else:
    probe()
