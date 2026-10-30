"""Qualify the real proxy and namespace firewall in disposable, fully offline networks."""
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

root = Path(__file__).resolve().parent.parent
prefix = "mira-egress-test-" + uuid.uuid4().hex
networks, containers = [], []

def main():
    """Use synthetic public addresses without adding a host route or reaching the Internet."""
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        environment = {"PATH": os.environ["PATH"], "HOME": directory}
        def docker(*args, timeout=30):
            result = subprocess.run(["docker", "--config", directory, "--host", "unix:///var/run/docker.sock", *args], cwd=root, env=environment, text=True, capture_output=True, timeout=timeout)
            if result.returncode:
                raise RuntimeError("Disposable Docker operation failed: " + result.stderr[-3000:])
            return result.stdout.strip()
        def network(suffix, subnet=None):
            name = prefix + "-" + suffix
            args = ["network", "create", "--internal", "--label", "mira.qualification=" + prefix,
                    "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated"]
            if subnet:
                args += ["--subnet", subnet]
            value = docker(*args, name)
            networks.append(value)
            return value
        def probe(network_id, proxy, url):
            name = prefix + "-probe-" + uuid.uuid4().hex[:8]
            containers.append(name)
            output = docker("run", "--rm", "--name", name, "--network", network_id,
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "65534:65534",
                "--read-only", "--memory", "96m", "--pids-limit", "32",
                "homelab-browser-egress-fixture:local", "probe", proxy, url, timeout=10)
            return json.loads(output)
        native_image = None
        client = None
        try:
            compose_environment = {**environment,
                "HOMELAB_MIRA_BROWSER_PROXY_IMAGE": "homelab-browser-proxy-test:local",
                "HOMELAB_MIRA_IMAGE": "homelab-mira-fixture:local",
                "HOMELAB_DOCKER_GID": "998",
                "HOMELAB_MIRA_BROWSER_CONFIG": str(Path(directory) / "host.json"),
                "HOMELAB_DASHBOARD_DATABASE_URL": "postgres://fixture:fixture@database/fixture"}
            rendered = subprocess.run(["docker", "--config", directory, "compose", "-f", "deploy/compose.browser.yaml", "config", "--format", "json"], cwd=root, env=compose_environment, check=True, capture_output=True, text=True, timeout=15)
            compose = json.loads(rendered.stdout)
            for suffix in ["a", "b"]:
                slot_name = "mira-browser-" + suffix
                proxy_service = compose["services"]["mira-browser-proxy-" + suffix]
                assert not proxy_service.get("ports") and not proxy_service.get("volumes")
                assert set(proxy_service["networks"]) == {slot_name, "mira-browser-outbound"}
                assert proxy_service["networks"][slot_name]["interface_name"] == "browser"
                assert compose["networks"][slot_name]["internal"] is True
                assert compose["networks"][slot_name]["driver_opts"]["com.docker.network.bridge.gateway_mode_ipv4"] == "isolated"
            host_service = compose["services"]["mira-browser-host"]
            assert not host_service.get("ports") and set(host_service["networks"]) == {"default"}
            assert host_service["command"] == ["bun", "--no-env-file", "hostCli.js"]
            client = network("client")
            # Isolated gateway mode creates no host bridge address/route. This prefix exists only in the fixture namespace.
            subnet = "1.1.1.0/29"
            public = network("public", subnet)
            client_info = json.loads(docker("network", "inspect", client))[0]
            private_base = ipaddress.ip_network(client_info["IPAM"]["Config"][0]["Subnet"])
            public_base = ipaddress.ip_network(subnet)
            private_ip, proxy_ip, public_ip = str(private_base.network_address + 3), str(private_base.network_address + 2), str(public_base.network_address + 1)
            site = prefix + "-site"
            containers.append(site)
            docker("create", "--name", site, "--network", public, "--ip", public_ip,
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,size=8m",
                "--memory", "128m", "--pids-limit", "64", "--env", "PUBLIC_IP=" + public_ip,
                "--env", "PRIVATE_IP=" + private_ip, "homelab-browser-egress-fixture:local", "serve")
            docker("network", "connect", "--ip", private_ip, client, site)
            docker("start", site)
            proxy = prefix + "-proxy"
            containers.append(proxy)
            docker("create", "--name", proxy,
                "--network", f"name={client},ip={proxy_ip},alias=mira-egress,driver-opt=com.docker.network.endpoint.ifname=browser",
                "--dns", public_ip, "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP",
                "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m,mode=1777",
                "--sysctl", "net.ipv4.ip_forward=0", "--memory", "128m", "--pids-limit", "64", "homelab-browser-proxy-test:local")
            docker("network", "connect", "--driver-opt", "com.docker.network.endpoint.ifname=external", public, proxy)
            docker("start", proxy)
            endpoint = "http://mira-egress:3128"

            # A user-defined network retains embedded DNS for its local aliases.
            # --dns changes external forwarding, not the embedded resolver address.
            dns_probe = prefix + "-dns-probe"
            containers.append(dns_probe)
            dns_code = """import pathlib,socket,json
assert 'nameserver 127.0.0.11' in pathlib.Path('/etc/resolv.conf').read_text()
assert socket.gethostbyname('mira-egress') == '""" + proxy_ip + """'
try:
    socket.getaddrinfo('public.mira.test',80)
except socket.gaierror:
    pass
else:
    raise AssertionError('External browser DNS must remain unavailable')
print(json.dumps({'localProxyAlias':True,'externalBrowserDnsBlocked':True}))
"""
            print(docker("run", "--rm", "--name", dns_probe, "--network", client, "--dns", "127.0.0.1",
                "--dns-option", "timeout:1", "--dns-option", "attempts:1",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "65534:65534",
                "--read-only", "--memory", "96m", "--pids-limit", "32", "--entrypoint", "python",
                "homelab-browser-egress-fixture:local", "-c", dns_code, timeout=10), flush=True)
            ready = None
            for _ in range(30):
                for service in [site, proxy]:
                    if docker("inspect", "--format", "{{.State.Running}}", service) != "true":
                        logs = subprocess.run(["docker", "logs", service], text=True, capture_output=True)
                        raise RuntimeError("Fixture stopped: " + logs.stdout[-3000:] + logs.stderr[-3000:])
                ready = probe(client, endpoint, "http://" + public_ip + "/")
                if ready["status"] == 200:
                    break
                time.sleep(.1)
            assert ready and ready["status"] == 200, (ready, docker("logs", proxy))
            print("public HTTP through proxy: pass", flush=True)
            assert probe(client, endpoint, "https://" + public_ip + "/")["status"] == 200
            assert probe(client, endpoint, "http://public.mira.test/")["status"] == 200
            for target in [private_ip, "127.0.0.1", "169.254.169.254", "100.64.0.1", "10.77.20.2", "192.168.1.1", "0.0.0.0", "[::1]", "[fc00::1]", "[::ffff:127.0.0.1]", "private.mira.test", "mixed.mira.test"]:
                assert probe(client, endpoint, "http://" + target + "/")["status"] == 403, target
            assert probe(client, endpoint, "http://" + public_ip + ":22/")["status"] == 403
            assert probe(client, endpoint, "https://" + private_ip + "/")["status"] == "blocked"
            assert probe(client, endpoint, "http://" + public_ip + "/redirect-private")["status"] == 403
            print("private addresses, mixed DNS, redirects and unsafe ports: pass", flush=True)
            assert probe(client, endpoint, "http://flip.mira.test/")["status"] == 200
            assert probe(client, endpoint, "http://" + public_ip + "/_flip")["status"] == 200
            # An existing positive cache entry can keep its original public address briefly; it must never reach the private interface.
            for _ in range(8):
                flipped = probe(client, endpoint, "http://flip.mira.test/")
                assert flipped["status"] in [200, 403, "blocked"]
                if flipped["status"] != 200:
                    break
                time.sleep(1)
            assert flipped["status"] in [403, "blocked"]
            # Independent direct probes share only the proxy network namespace, not Squid's ACL implementation.
            assert probe("container:" + proxy, "direct", "http://" + public_ip + "/")["status"] == 200
            assert probe("container:" + proxy, "direct", "http://" + private_ip + "/")["status"] == "blocked"
            assert probe(client, "direct", "http://" + public_ip + "/")["status"] == "blocked"
            assert probe(public, "direct", "http://" + proxy_ip + ":3128/")["status"] == "blocked"
            evidence = probe(client, endpoint, "http://" + public_ip + "/_state")
            assert json.loads(evidence["body"])["privateHits"] == 0
            status = docker("exec", proxy, "cat", "/proc/1/status")
            for field in ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]:
                assert next(line.split()[1] for line in status.splitlines() if line.startswith(field + ":")) == "0000000000000000", field
            assert "NoNewPrivs:\t1" in status
            print(json.dumps({"http": True, "https": True, "dnsRebinding": True, "privateHits": 0, "kernelEgress": True, "noDirectBrowserRoute": True, "runtimeCapabilitiesDropped": True}), flush=True)
            # The native session has a dedicated slot; remove the hostile fixture peer first.
            docker("network", "disconnect", client, site)
            for _ in range(30):
                if docker("inspect", "--format", "{{.State.Health.Status}}", proxy) == "healthy":
                    break
                time.sleep(.2)
            config = {"socketPath": str(Path("/var/run/docker.sock").resolve()),
                "imageId": docker("image", "inspect", "--format", "{{.Id}}", "homelab-browser-egress-runtime:local"),
                "egress": {"networkId": client, "proxyId": docker("inspect", "--format", "{{.Id}}", proxy),
                    "proxyImageId": docker("inspect", "--format", "{{.Image}}", proxy)}}
            native_image = config["imageId"]
            config_path = Path(directory) / "host.json"
            config_path.write_text(json.dumps(config))
            try:
                subprocess.run(["bun", "--no-env-file", "apps/mira/src/server/testing/browserEgressSmoke.ts", str(config_path)], cwd=root, env=environment, check=True, timeout=120)
            except Exception:
                info = json.loads(docker("inspect", proxy))[0]
                print(json.dumps({"proxy": {key: info[key] for key in ["Id", "Image", "Config", "HostConfig", "Mounts", "NetworkSettings", "State"]}}), flush=True)
                raise

        finally:
            if native_image and client:
                # A killed host test may not reach its async close. Reap only this fixture's
                # exact image, generated owner/name and labelled private network members.
                info = json.loads(docker("network", "inspect", client))[0]
                assert info["Labels"]["mira.qualification"] == prefix
                for identity in info["Containers"]:
                    item = json.loads(docker("inspect", identity))[0]
                    owner = item["Config"].get("Labels", {}).get("io.homelab.mira.browser-owner")
                    if owner and item["Image"] == native_image and item["Name"] == "/mira-browser-" + owner:
                        uuid.UUID(owner)
                        docker("rm", "-f", identity)
            for name in reversed(containers):
                subprocess.run(["docker", "--config", directory, "--host", "unix:///var/run/docker.sock", "rm", "-f", name], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            for name in reversed(networks):
                docker("network", "rm", name)

if __name__ == "__main__":
    main()
