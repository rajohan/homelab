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
    remote.verify_code_mounts({"volumes": [{"type": "bind", "target": "/opt/homelab/logout-worker.js"}]})
    for destination in ["/opt/homelab/custom-entrypoint.py", "/opt/homelab/custom-worker.js",
                        "/opt/homelab/logout-worker.js/extra.js", "/opt/homelab/../homelab/logout-worker.js",
                        "/usr/local/bin/custom-entrypoint.sh", "/config/start.sh", "/usr/local/bin/extensionless",
                        "/usr/libexec/worker", "/custom/program.exe"]:
        try:
            remote.verify_code_mounts({"volumes": [{"type": "bind", "target": destination}]})
            raise AssertionError("An unqualified helper code mount was accepted")
        except remote.UpdateRefusal as error:
            assert error.reason == "local_code_override"
    image = json.loads(command(["/usr/bin/docker", "image", "inspect", "postgres:18"]))[0]
    digest = next(value.split("@", 1)[1] for value in image["RepoDigests"] if value.startswith("postgres@"))
    original = "postgres@" + digest
    candidate = "docker.io/library/postgres:18@" + digest
    inherited_image = "homelab-fixtures/" + owner + ":inherited"
    with tempfile.TemporaryDirectory(prefix=owner + "-") as temporary:
        directory = Path(temporary).resolve()
        provider_file = directory / "provider.yaml"
        consumer_file = directory / "consumer.yaml"
        main_file = directory / "compose.yaml"
        overlay_file = directory / "overlay.yaml"
        helpers = []
        for service, destination in [("custom-helper", "/opt/homelab/custom-entrypoint.py"), ("shell-helper", "/usr/local/bin/custom-entrypoint.sh"), ("extensionless-helper", "/custom/start"), ("pending-helper", "/custom/start"), ("module-helper", "/custom"), ("inherited-helper", "/custom"), ("library-helper", "/usr/local/lib/python3.13/site-packages")]:
            helper_file = directory / (service + ".yaml")
            entrypoint_file = directory / (service + ".source")
            entrypoint_file.write_text("#!/bin/sh\nexec /bin/sleep 3600\n")
            if service in ("module-helper", "inherited-helper", "library-helper"):
                entrypoint_file = directory / (service + "-code")
                entrypoint_file.mkdir()
                (entrypoint_file / "app.py").write_text("# Synthetic module source, never executed.\n")
            helper_file.write_text("services:\n  " + service + ":\n    image: " + original + "\n    entrypoint: [/bin/sh, " + destination + "]\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n    volumes:\n      - type: bind\n        source: " + str(entrypoint_file) + "\n        target: " + destination + "\n        read_only: true\n")
            helpers.append((service, helper_file))
            if service in ("pending-helper", "module-helper", "inherited-helper", "library-helper"):
                helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sh, " + destination + "]", "entrypoint: [/bin/sleep]\n    command: ['3600']"))
            if service == "inherited-helper":
                helper_file.write_text(helper_file.read_text().replace(original, inherited_image))
        # A mounted executable can also be invoked later, outside startup argv.
        executable = directory / "extensionless-binary"
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        try:
            remote.verify_code_mounts({"volumes": [{"type": "bind", "source": str(executable), "target": "/custom/utility"}]})
            raise AssertionError("An executable bind without a suffix was accepted")
        except remote.UpdateRefusal as error:
            assert error.reason == "local_code_override"
        remote.verify_code_mounts({"entrypoint": ["/vendor/app"], "command": ["--config", "/config/app.json"], "volumes": [{"type": "bind", "target": "/config"}]})
        patch_file = directory / "legacy.py"
        patch_file.write_text("# Synthetic obsolete application override; never production code.\n")
        overlay_file.write_text("services:\n  overlay:\n    image: " + original + "\n    entrypoint: [/bin/sleep]\n    command: ['3600']\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n    volumes:\n      - type: bind\n        source: " + str(patch_file) + "\n        target: /app/services/legacy.py\n        read_only: true\n")
        shared = {"image": original, "init": True, "entrypoint": ["/bin/sleep"], "command": ["3600"], "mem_limit": "64m", "pids_limit": 32, "labels": {"homelab.smoke": owner}, "healthcheck": {"test": ["CMD", "true"], "interval": "1s", "retries": 2}, "volumes": ["marker:/marker"]}
        # The real updater deliberately edits a literal YAML pin; other fixtures may use JSON/YAML.
        provider_file.write_text("services:\n  provider:\n    image: " + original + "\n    init: true\n    entrypoint: [/bin/sleep]\n    command: ['3600']\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n    healthcheck:\n      test: [CMD, 'true']\n      interval: 1s\n")
        consumer_file.write_text("services:\n  consumer:\n    image: " + original + "\n" + "".join("    " + key + ": " + json.dumps(value) + "\n" for key, value in {**shared, "network_mode": "service:provider"}.items() if key != "image"))
        main_file.write_text(json.dumps({"include": [str(provider_file), str(consumer_file), str(overlay_file)] + [str(path) for _, path in helpers], "services": {"stopped": {**shared, "network_mode": "service:provider"}, "leaf": {**shared, "network_mode": "service:consumer"}}, "volumes": {"marker": {"labels": {"homelab.smoke": owner}}}}))
        base = ["/usr/bin/docker", "compose", "--project-directory", str(directory), "--project-name", owner, "--file", str(main_file)]
        def compose(args, timeout=120):
            return command(base + args, timeout=timeout)
        image_built = False
        try:
            build_directory = directory / "image"
            build_directory.mkdir()
            (build_directory / "Dockerfile").write_text("FROM postgres:18\nENTRYPOINT [\"python\"]\nCMD [\"/vendor/app.py\"]\n")
            # BuildKit needs a writable client state directory; scope it to this
            # disposable fixture instead of the updater's /nonexistent HOME.
            command(["/usr/bin/docker", "build", "--pull=false", "--network=none", "--label", "homelab.smoke=" + owner, "--tag", inherited_image, str(build_directory)], environment={"HOME": str(build_directory)})
            image_built = True
            compose(["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "20"])
            # Change Compose only, keeping the live startup vector on /bin/sleep.
            # Both pending extensionless scripts and cwd module execution must
            # fail before a pull, pin edit or replacement of the current container.
            for service, helper_file in helpers:
                if service == "pending-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, /custom/start]"))
                elif service == "module-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "working_dir: /custom\n    entrypoint: [python]\n    command: ['-m', app]"))
                elif service == "inherited-helper":
                    # Remove the OLD container override: the image supplies Python,
                    # while pending Compose supplies only module args and cwd.
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "working_dir: /custom\n    command: ['-m', app]"))
            compose(["stop", "stopped"])
            before = {service: remote.namespace_snapshot(owner + "-" + service + "-1") for service in ("provider", "consumer", "stopped", "leaf")}
            command(["/usr/bin/docker", "exec", before["consumer"][0], "/bin/sh", "-ec", "printf persistent > /marker/probe"])
            driver = {"kind": "docker", "name": owner + "-provider-1", "project": owner, "service": "provider", "directory": str(directory), "file": str(main_file), "imageFile": str(provider_file), "namespaceDependents": ["consumer", "stopped", "leaf"]}
            item = {"id": "docker:" + before["provider"][0], "image": original, "installed": image["Id"], "available": image["Id"], "availableImage": candidate}
            for overlay_service, overlay_source in [("overlay", overlay_file)] + helpers:
                overlay_name = owner + "-" + overlay_service + "-1"
                overlay_before = remote.namespace_snapshot(overlay_name)
                try:
                    def no_pull(arguments, **options):
                        assert arguments[1] != "pull", "Preflight must refuse mounted code before pull"
                        return command(arguments, **options)
                    remote.command = no_pull
                    overlay_item = {**item, "id": "docker:" + overlay_before[0]}
                    if overlay_service == "inherited-helper":
                        overlay_item.update(image=inherited_image, installed=overlay_before[3], available=overlay_before[3], availableImage="docker.io/homelab-fixtures/" + owner + ":candidate@sha256:" + "a" * 64)
                    remote.docker_update({**driver, "name": overlay_name, "service": overlay_service, "imageFile": str(overlay_source), "namespaceDependents": []}, overlay_item)
                    raise AssertionError("An obsolete executable overlay was allowed through the updater")
                except remote.UpdateRefusal as error:
                    assert error.reason == "local_code_override"
                finally:
                    remote.command = command
                assert remote.namespace_snapshot(overlay_name) == overlay_before
                assert overlay_item["image"] in overlay_source.read_text() and overlay_item["availableImage"] not in overlay_source.read_text()
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
            if image_built:
                assert command(["/usr/bin/docker", "image", "inspect", "--format", '{{index .Config.Labels "homelab.smoke"}}', inherited_image]) == owner
                command(["/usr/bin/docker", "image", "rm", inherited_image])


if __name__ == "__main__":
    main()
