"""Qualify the shared check image through a disposable isolated public-egress slot."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

root = Path(__file__).resolve().parent.parent
prefix = "mira-local-check-" + uuid.uuid4().hex
containers, networks = [], []


def main():
    """Run only public-source qualification; remove every owned test resource afterward."""
    commit, image, proxy_image, *extra = sys.argv[1:]
    if extra not in ([], ["--full"]):
        raise ValueError("Expected exact public commit, local images and optional --full")
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        env = {"PATH": os.environ["PATH"], "HOME": directory}

        def docker(*args):
            result = subprocess.run(["docker", "--config", directory, "--host", "unix:///var/run/docker.sock", *args], cwd=root, env=env, text=True, capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError("Qualification Docker operation failed: " + result.stderr[-2000:])
            return result.stdout.strip()

        try:
            private = docker("network", "create", "--internal", "--opt", "com.docker.network.bridge.gateway_mode_ipv4=isolated", prefix + "-private")
            networks.append(private)
            public = docker("network", "create", prefix + "-outbound")
            networks.append(public)
            proxy = prefix + "-proxy"
            containers.append(proxy)
            docker("create", "--name", proxy, "--network", f"name={private},alias=mira-egress,driver-opt=com.docker.network.endpoint.ifname=browser",
                   "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "SETPCAP",
                   "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m,mode=1777",
                   "--sysctl", "net.ipv4.ip_forward=0", "--memory", "128m", "--pids-limit", "64", proxy_image)
            docker("network", "connect", "--driver-opt", "com.docker.network.endpoint.ifname=external", public, proxy)
            docker("start", proxy)
            for _ in range(100):
                if docker("inspect", "--format", "{{.State.Health.Status}}", proxy) == "healthy":
                    break
                time.sleep(.2)
            config = {"socketPath": str(Path("/var/run/docker.sock").resolve()),
                      "imageId": docker("image", "inspect", "--format", "{{.Id}}", image),
                      "egress": {"networkId": private, "proxyId": docker("inspect", "--format", "{{.Id}}", proxy),
                                 "proxyImageId": docker("inspect", "--format", "{{.Image}}", proxy)}}
            config_file = Path(directory) / "host.json"
            config_file.write_text(json.dumps(config))
            subprocess.run(["bun", "--no-env-file", "apps/mira/src/server/testing/localCodeSmoke.ts", str(config_file), commit, *extra], cwd=root, env=env, check=True, timeout=750)
        finally:
            # Include only this fixture's private network peers; never prune unrelated host resources.
            for network in networks[:1]:
                found = json.loads(docker("network", "inspect", network))[0]
                containers.extend(found.get("Containers", {}).keys())
            failures = []
            for container in dict.fromkeys(containers):
                result = subprocess.run(["docker", "--config", directory, "--host", "unix:///var/run/docker.sock", "rm", "--force", "--volumes", container], env=env, text=True, capture_output=True, timeout=30)
                if result.returncode and "No such container" not in result.stderr:
                    failures.append(container)
            for network in reversed(networks):
                try:
                    docker("network", "rm", network)
                except RuntimeError:
                    failures.append(network)
            if failures:
                raise RuntimeError("Qualification cleanup failed for " + ", ".join(failures))


if __name__ == "__main__":
    main()
