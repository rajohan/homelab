"""Run the unmocked Docker updater on isolated, exact-owned Compose fixtures."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import uuid

source = Path(__file__).resolve().parents[1] / "apps/dashboard/src/server/integrations/updates/remote.py"
spec = importlib.util.spec_from_file_location("docker_update_smoke", source)
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
remote.hashlib = hashlib
exec(compile(source.with_name("docker_dependencies.py").read_text(), str(source.with_name("docker_dependencies.py")), "exec"), remote.__dict__)


def main():
    """Verify real pull identity, namespace rebinding, mounts and stopped state with scoped cleanup."""
    owner = "homelab-update-smoke-" + uuid.uuid4().hex
    command = remote.command
    image = json.loads(command(["/usr/bin/docker", "image", "inspect", "postgres:18"]))[0]
    digest = next(value.split("@", 1)[1] for value in image["RepoDigests"] if value.startswith("postgres@"))
    original = "postgres@" + digest
    candidate = "docker.io/library/postgres:18@" + digest
    with tempfile.TemporaryDirectory(prefix=owner + "-") as temporary:
        directory = Path(temporary).resolve()
        provider_file = directory / "provider.yaml"
        consumer_file = directory / "consumer.yaml"
        main_file = directory / "compose.yaml"
        shared = {"image": original, "init": True, "entrypoint": ["/bin/sleep"], "command": ["3600"], "mem_limit": "64m", "pids_limit": 32, "labels": {"homelab.smoke": owner}, "healthcheck": {"test": ["CMD", "true"], "interval": "1s", "retries": 2}, "volumes": ["marker:/marker"]}
        # The real updater deliberately edits a literal YAML pin; other fixtures may use JSON/YAML.
        provider_file.write_text("services:\n  provider:\n    image: " + original + "\n    init: true\n    entrypoint: [/bin/sleep]\n    command: ['3600']\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n    healthcheck:\n      test: [CMD, 'true']\n      interval: 1s\n")
        consumer_file.write_text("services:\n  consumer:\n    image: " + original + "\n" + "".join("    " + key + ": " + json.dumps(value) + "\n" for key, value in {**shared, "network_mode": "service:provider"}.items() if key != "image"))
        main_file.write_text(json.dumps({"include": [str(provider_file), str(consumer_file)], "services": {"stopped": {**shared, "network_mode": "service:provider"}, "leaf": {**shared, "network_mode": "service:consumer"}}, "volumes": {"marker": {"labels": {"homelab.smoke": owner}}}}))
        base = ["/usr/bin/docker", "compose", "--project-directory", str(directory), "--project-name", owner, "--file", str(main_file)]
        def compose(args, timeout=120):
            return command(base + args, timeout=timeout)
        try:
            compose(["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "20"])
            compose(["stop", "stopped"])
            before = {service: remote.namespace_snapshot(owner + "-" + service + "-1") for service in ("provider", "consumer", "stopped", "leaf")}
            command(["/usr/bin/docker", "exec", before["consumer"][0], "/bin/sh", "-ec", "printf persistent > /marker/probe"])
            driver = {"kind": "docker", "name": owner + "-provider-1", "project": owner, "service": "provider", "directory": str(directory), "file": str(main_file), "imageFile": str(provider_file), "namespaceDependents": ["consumer", "stopped", "leaf"]}
            item = {"id": "docker:" + before["provider"][0], "image": original, "installed": image["Id"], "available": image["Id"], "availableImage": candidate}
            compose(["stop", "--timeout", "5", "consumer"])
            broken = {service: remote.namespace_snapshot(row[0]) for service, row in before.items()}
            try:
                remote.docker_update(driver, item)
                raise AssertionError("A stopped intermediate provider with a running descendant was accepted")
            except RuntimeError as error:
                assert "stopped namespace provider" in str(error)
            assert {service: remote.namespace_snapshot(row[0]) for service, row in before.items()} == broken
            assert original in provider_file.read_text()
            compose(["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "20", "consumer"])
            # A missing approval must fail before touching a running provider.
            try:
                remote.docker_update({**driver, "namespaceDependents": []}, item)
                raise AssertionError("Unapproved dependent was not rejected")
            except RuntimeError as error:
                assert "approval" in str(error)
            assert remote.namespace_snapshot(before["provider"][0]) == before["provider"]
            try:
                remote.docker_update({**driver, "healthChecks": [["/usr/bin/false"]]}, item)
                raise AssertionError("Failed baseline health was not rejected")
            except RuntimeError:
                pass
            assert remote.namespace_snapshot(before["provider"][0]) == before["provider"]
            assert original in provider_file.read_text()
            rogue = command(["/usr/bin/docker", "create", "--name", owner + "-outside", "--label", "homelab.smoke=" + owner, "--network", "container:" + before["provider"][0], "--entrypoint", "/bin/sleep", "postgres:18", "3600"])
            try:
                try:
                    remote.docker_update(driver, item)
                    raise AssertionError("Unapproved external namespace consumer was not rejected")
                except RuntimeError as error:
                    assert "unapproved" in str(error)
                assert remote.namespace_snapshot(before["provider"][0]) == before["provider"]
            finally:
                assert command(["/usr/bin/docker", "inspect", "--format", '{{index .Config.Labels "homelab.smoke"}}', rogue]) == owner
                command(["/usr/bin/docker", "rm", "--force", "--volumes", rogue])
            # Reproduce a new reverse edge arriving while an actual image pull is in progress.
            rogue = None
            def changing_command(arguments, **options):
                nonlocal rogue
                result = command(arguments, **options)
                if arguments[1] == "pull":
                    rogue = command(["/usr/bin/docker", "create", "--name", owner + "-during-pull", "--label", "homelab.smoke=" + owner, "--network", "container:" + before["provider"][0], "--entrypoint", "/bin/sleep", "postgres:18", "3600"])
                return result
            stable = {service: remote.namespace_snapshot(row[0]) for service, row in before.items()}
            try:
                remote.command = changing_command
                try:
                    remote.docker_update(driver, item)
                    raise AssertionError("A namespace consumer created during pull was accepted")
                except RuntimeError as error:
                    assert "unapproved" in str(error)
                assert {service: remote.namespace_snapshot(row[0]) for service, row in before.items()} == stable
                assert original in provider_file.read_text()
            finally:
                remote.command = command
                if rogue:
                    assert command(["/usr/bin/docker", "inspect", "--format", '{{index .Config.Labels "homelab.smoke"}}', rogue]) == owner
                    command(["/usr/bin/docker", "rm", "--force", "--volumes", rogue])
            try:
                assert remote.docker_update(driver, item) == image["Id"]
            except RuntimeError:
                for service in before:
                    current = remote.namespace_snapshot(owner + "-" + service + "-1")
                    if current[11] != before[service][11]:
                        print(json.dumps({"fixture": service, "mounts_before": before[service][11], "mounts_after": current[11]}))
                raise
            after = {service: remote.namespace_snapshot(owner + "-" + service + "-1") for service in before}
            assert after["provider"][0] != before["provider"][0]
            assert after["consumer"][0] != before["consumer"][0]
            assert after["consumer"][8] == "container:" + after["provider"][0]
            assert after["stopped"][8] == "container:" + after["provider"][0]
            assert after["stopped"][4] == "created"
            assert after["consumer"][2:4] == before["consumer"][2:4]
            assert command(["/usr/bin/docker", "exec", after["consumer"][0], "cat", "/marker/probe"]) == "persistent"
            net = lambda identity: command(["/usr/bin/docker", "exec", identity, "readlink", "/proc/self/ns/net"])
            assert net(after["provider"][0]) == net(after["consumer"][0])
            consumer_driver = {**driver, "name": owner + "-consumer-1", "service": "consumer", "imageFile": str(consumer_file), "namespaceDependents": ["leaf"]}
            consumer_item = {**item, "id": "docker:" + after["consumer"][0]}
            assert remote.docker_update(consumer_driver, consumer_item) == image["Id"]
            assert remote.namespace_snapshot(owner + '-provider-1')[0] == after['provider'][0]
            assert net(owner + '-provider-1') == net(owner + '-consumer-1')
            probe = directory / 'probe-count'
            probe_command = ["/usr/bin/python3", "-c", "from pathlib import Path; import sys; p=Path(sys.argv[1]); n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n)); sys.exit(n>1)", str(probe)]
            current_consumer = remote.namespace_snapshot(owner + '-consumer-1')
            failure_item = {**consumer_item, 'id': 'docker:' + current_consumer[0], 'image': candidate, 'availableImage': 'docker.io/library/postgres:18-bookworm@' + digest}
            try:
                remote.docker_update({**consumer_driver, 'healthChecks': [probe_command]}, failure_item)
                raise AssertionError('A failed post-update functional probe reported success')
            except RuntimeError:
                pass
            assert probe.read_text() == '2'
            assert remote.namespace_snapshot(owner + '-consumer-1')[0] != current_consumer[0]
            compose(['stop', '--timeout', '5'])
            current = remote.namespace_snapshot(owner + '-provider-1')
            stopped_item = {**item, 'id': 'docker:' + current[0], 'image': candidate, 'availableImage': 'docker.io/library/postgres:18-bookworm@' + digest}
            assert remote.docker_update(driver, stopped_item) == image['Id']
            assert all(remote.namespace_snapshot(owner + '-' + service + '-1')[4] == 'created' for service in before)
            assert not list(directory.glob(".homelab-update-*"))
            print("PASS: unmocked Docker pull/inspect/Compose updater, exact pins, external-consumer refusal, baseline/post-update health failures, provider and consumer updates, retained data and stopped-project preservation.")
        finally:
            ids = compose(["ps", "--all", "--quiet"]).split()
            for identity in ids:
                assert command(["/usr/bin/docker", "inspect", "--format", '{{index .Config.Labels "homelab.smoke"}}', identity]) == owner
            compose(["down", "--volumes", "--timeout", "5"])


if __name__ == "__main__":
    main()
