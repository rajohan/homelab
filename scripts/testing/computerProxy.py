"""Qualify the shipped private nginx configuration against a disposable real receiver."""
import http.client
import os
import socket
import ssl
import subprocess
import time


def qualify_computer_proxy(command, root, directory, owner, upstream_port):
    """Exercise TLS, original peer checks, browser refusal and payload bounds without live routing."""
    if os.getuid() == 0:
        raise RuntimeError("Run private-proxy qualification as an unprivileged Docker user.")
    image = owner + "-proxy:test"
    container = owner + "-proxy"
    built = False
    created = False
    fixture = directory / "proxy"
    fixture.mkdir(mode=0o700)
    docker_config = fixture / "docker-config"
    docker_config.mkdir(mode=0o700)
    with socket.socket() as reservation:
        reservation.bind(("0.0.0.0", 0))
        port = reservation.getsockname()[1]
    try:
        command(["docker", "build", "--tag", image,
                 str(root / "deploy/computer-proxy-test")], timeout=180,
                environment={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                             "HOME": "/nonexistent", "DOCKER_CONFIG": str(docker_config)})
        built = True
        command(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-noenc",
                 "-days", "1", "-subj", "/CN=computer.example.test",
                 "-addext", "subjectAltName=DNS:computer.example.test,DNS:other.example.test",
                 "-keyout", str(fixture / "key.pem"), "-out", str(fixture / "cert.pem")])
        replacements = {
            "@PEER@": "127.0.0.3/32",
            "@PRIVATE_LISTENER@": "127.0.0.2:" + str(port),
            "@HOSTNAME@": "computer.example.test",
            "@CERTIFICATE@": "/fixture/cert.pem",
            "@CERTIFICATE_KEY@": "/fixture/key.pem",
            "http://127.0.0.1:3113": "http://127.0.0.1:" + str(upstream_port),
        }
        config = (root / "deploy/nginx/computer.conf.example").read_text()
        for before, after in replacements.items():
            config = config.replace(before, after)
        assert "@" not in config
        (fixture / "computer.conf").write_text(config)
        # Deliberately inherit a broad real-IP rule. Forged headers must still not
        # authorize the original, denied socket peer at this private listener.
        (fixture / "nginx.conf").write_text("""pid /tmp/nginx.pid;
error_log stderr warn;
events { worker_connections 64; }
http {
    client_body_temp_path /tmp/body;
    proxy_temp_path /tmp/proxy;
    fastcgi_temp_path /tmp/fastcgi;
    uwsgi_temp_path /tmp/uwsgi;
    scgi_temp_path /tmp/scgi;
    set_real_ip_from 127.0.0.0/8;
    real_ip_header X-Forwarded-For;
    real_ip_recursive on;
    include /fixture/computer.conf;
}
""")
        run = ["docker", "run", "--name", container, "--network", "host",
               "--user", str(os.getuid()) + ":" + str(os.getgid()), "--read-only",
               "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
               "--cpus", "1", "--memory", "96m", "--pids-limit", "32",
               "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m",
               "--mount", "type=bind,source=" + str(fixture) + ",target=/fixture,readonly",
               "--entrypoint", "nginx"]
        # Name is owned before launch so a failed/ambiguous startup remains cleanable.
        command(["docker", "create", *run[2:], image, "-c", "/fixture/nginx.conf", "-g", "daemon off;"])
        created = True
        command(["docker", "start", container])
        trusted = ssl.create_default_context(cafile=str(fixture / "cert.pem"))

        def request(route, expected, method="GET", headers=None, body=None,
                    peer="127.0.0.3", hostname="computer.example.test", context=trusted):
            connection = http.client.HTTPConnection(hostname, port, timeout=5)
            try:
                raw = socket.create_connection(("127.0.0.2", port), timeout=5,
                                               source_address=(peer, 0))
                try:
                    connection.sock = context.wrap_socket(raw, server_hostname=hostname)
                except BaseException:
                    raw.close()
                    raise
                connection.request(method, route, body=body, headers=headers or {})
                response = connection.getresponse()
                assert response.status == expected, (route, response.status, expected)
                response.read(4096)
            finally:
                connection.close()

        deadline = time.monotonic() + 15
        while True:
            try:
                request("/api/mira/computers/connect", 405)
                break
            except (ConnectionRefusedError, ConnectionResetError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.1)
        # Reject untrusted certificates, despite a reachable listener and matching hostname.
        try:
            request("/api/mira/computers/connect", 405, context=ssl.create_default_context())
        except ssl.SSLCertVerificationError:
            pass
        else:
            raise AssertionError("Untrusted TLS certificate was accepted.")
        request("/api/mira/computers/connect", 403, peer="127.0.0.4")
        request("/api/mira/computers/connect", 403, peer="127.0.0.4",
                headers={"X-Forwarded-For": "127.0.0.3", "X-Real-IP": "127.0.0.3"})
        request("/api/mira/computers/connect", 405, headers={"X-Forwarded-For": "127.0.0.4"})
        request("/api/mira/computers/connect", 421, hostname="other.example.test")
        request("/api/mira/computers/connect", 421, headers={"Host": "other.example.test"})
        for route in ["/", "/api/trpc", "/api/mira/computers/unknown", "/api/mira/computers/connect?x=1"]:
            request(route, 404)
        headers = {"Content-Type": "application/json",
                   "Authorization": "Bearer mira_device_00000000-0000-4000-8000-000000000001." + "A" * 43}
        # Invalid schema distinguishes upstream delivery (400) from browser refusal (403).
        request("/api/mira/computers/commands/finish", 400, "POST", headers, b"{}")
        request("/api/mira/computers/commands/finish", 403, "POST",
                {**headers, "Origin": "https://dashboard.example.test"}, b"{}")
        request("/api/mira/computers/commands/finish", 403, "POST",
                {**headers, "Cookie": "synthetic=fixture"}, b"{}")
        request("/api/mira/computers/connect", 403, "POST", {"Content-Type": "application/json"}, b"{}")
        request("/api/mira/computers/commands/finish", 400, "POST", headers,
                b'{"fixture":"' + b"A" * (2 * 1024 * 1024) + b'"}')
        request("/api/mira/computers/commands/finish", 413, "POST",
                {**headers, "Content-Length": str(3 * 1024 * 1024 + 1)}, b"")
        # Exact IPv4 binding must not create sibling loopback or IPv6 listeners.
        for host in ["127.0.0.1", "::1"]:
            try:
                with socket.create_connection((host, port), timeout=1):
                    raise AssertionError("Unexpected additional proxy listener.")
            except ConnectionRefusedError:
                pass
        print("Private TLS proxy passed: certificate verification, original peer gate, host/SNI, browser refusal and 3 MiB boundary.")
    except Exception:
        if created:
            logs = subprocess.run(["docker", "logs", "--tail", "15", container],
                                  env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": "/nonexistent"},
                                  capture_output=True, text=True, timeout=5, check=False)
            # Only this synthetic proxy is inspected; it never receives real credentials.
            print((logs.stdout + logs.stderr)[-3000:])
        raise
    finally:
        try:
            if created:
                command(["docker", "rm", "--force", container])
        finally:
            if built:
                command(["docker", "image", "rm", image])
