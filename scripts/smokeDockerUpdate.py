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
    consumer_tag = "postgres:" + owner + "-consumer"
    config_image = "homelab-fixtures/" + owner + ":config"
    health_image = "homelab-fixtures/" + owner + ":health"
    shell_image = "homelab-fixtures/" + owner + ":shell"
    symlink_image = "homelab-fixtures/" + owner + ":symlink"
    with tempfile.TemporaryDirectory(prefix=owner + "-") as temporary:
        directory = Path(temporary).resolve()
        provider_file = directory / "provider.yaml"
        consumer_file = directory / "consumer.yaml"
        main_file = directory / "compose.yaml"
        overlay_file = directory / "overlay.yaml"
        helpers = []
        for service, destination in [("custom-helper", "/opt/homelab/custom-entrypoint.py"), ("shell-helper", "/usr/local/bin/custom-entrypoint.sh"), ("extensionless-helper", "/custom/start"), ("pending-helper", "/custom/start"), ("module-helper", "/custom"), ("inherited-helper", "/custom"), ("option-helper", "/custom"), ("env-helper", "/custom"), ("library-helper", "/usr/local/lib/python3.13/site-packages")]:
            helper_file = directory / (service + ".yaml")
            entrypoint_file = directory / (service + ".source")
            entrypoint_file.write_text("#!/bin/sh\nexec /bin/sleep 3600\n")
            if service in ("module-helper", "inherited-helper", "option-helper", "env-helper", "library-helper"):
                entrypoint_file = directory / (service + "-code")
                entrypoint_file.mkdir()
                (entrypoint_file / "app.py").write_text("# Synthetic module source, never executed.\n")
            helper_file.write_text("services:\n  " + service + ":\n    image: " + original + "\n    entrypoint: [/bin/sh, " + destination + "]\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n    volumes:\n      - type: bind\n        source: " + str(entrypoint_file) + "\n        target: " + destination + "\n        read_only: true\n")
            helpers.append((service, helper_file))
            if service in ("pending-helper", "module-helper", "inherited-helper", "option-helper", "env-helper", "library-helper"):
                helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sh, " + destination + "]", "entrypoint: [/bin/sleep]\n    command: ['3600']"))
            if service in ("inherited-helper", "option-helper"):
                helper_file.write_text(helper_file.read_text().replace(original, inherited_image))
        for service, kind in (("assignment-helper", "volumes"), ("config-helper", "configs"), ("secret-helper", "secrets"), ("newline-helper", "volumes"), ("volume-helper", "named-volume"), ("expansion-helper", "volumes"), ("health-helper", "volumes"), ("inherited-health-helper", "volumes"), ("compound-helper", "volumes"), ("conditional-helper", "volumes"), ("compound-health-helper", "volumes"), ("dispatch-helper", "volumes"), ("dispatch-cwd-helper", "volumes"), ("dispatch-health-helper", "volumes"), ("launcher-helper", "volumes"), ("loader-helper", "named-volume"), ("shell-option-helper", "volumes"), ("trap-helper", "volumes"), ("jvm-helper", "volumes"), ("post-hook-helper", "volumes"), ("pre-hook-helper", "volumes"), ("hook-environment-helper", "volumes"), ("path-helper", "volumes"), ("expanded-script-helper", "volumes"), ("runtime-option-helper", "volumes"), ("ruby-option-helper", "volumes"), ("hash-helper", "volumes"), ("exec-arg-helper", "volumes"), ("init-arg-helper", "volumes"), ("volumes-from-helper", "inherited-volume"), ("external-volumes-helper", "inherited-volume"), ("coproc-helper", "named-volume"), ("coproc-health-helper", "volumes"), ("builtin-loader-helper", "named-volume"), ("custom-shell-helper", "volumes"), ("alias-helper", "named-volume"), ("python-inline-helper", "volumes"), ("awk-helper", "named-volume"), ("find-helper", "volumes"), ("module-cli-helper", "volumes"), ("make-helper", "volumes"), ("cdpath-helper", "volumes"), ("symlink-helper", "named-volume"), ("stdin-helper", "volumes"), ("history-helper", "named-volume"), ("helper-entrypoint", "helper-file"), ("helper-hook", "helper-file"), ("variable-helper", "volumes")):
            helper_file = directory / (service + ".yaml")
            source_file = directory / (service + ".source")
            source_file.write_text("# Synthetic startup code, never executed.\n")
            text = "services:\n  " + service + ":\n    image: " + original + "\n    entrypoint: [/bin/sleep]\n    command: ['3600']\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n"
            if kind == "volumes":
                source_directory = directory / (service + "-code")
                source_directory.mkdir()
                (source_directory / "start").write_text(source_file.read_text())
                text += "    volumes:\n      - type: bind\n        source: " + str(source_directory) + "\n        target: /custom\n        read_only: true\n"
            elif kind == "helper-file":
                text += "    volumes:\n      - type: bind\n        source: " + str(source_file) + "\n        target: /opt/homelab/logout-worker.js\n        read_only: true\n"
            elif kind == "named-volume":
                text += "    volumes:\n      - type: volume\n        source: startup-code\n        target: /custom\nvolumes:\n  startup-code:\n    labels:\n      homelab.smoke: " + owner + "\n"
            elif kind in ("configs", "secrets"):
                text += "    " + kind + ":\n      - source: " + service + "\n        target: /custom/start\n" + kind + ":\n  " + service + ":\n    file: " + str(source_file) + "\n"
            helper_file.write_text(text)
            if service == "inherited-health-helper":
                helper_file.write_text(text.replace(original, health_image) + "    healthcheck:\n      disable: true\n")
            elif service == "custom-shell-helper":
                shell_file = directory / (service + "-code") / "shell"
                shell_file.write_text('#!/bin/sh\nexec /bin/sh "$@"\n')
                shell_file.chmod(0o755)
                helper_file.write_text(text.replace(original, shell_image) + "    healthcheck:\n      test: [CMD, /bin/true]\n      interval: 1s\n")
            helpers.append((service, helper_file))
        for service in ("brace-helper", "sed-helper", "stack-helper"):
            helper_file = directory / (service + ".yaml")
            helper_file.write_text("services:\n  " + service + ":\n    image: " + original + "\n    entrypoint: [/bin/sleep]\n    command: ['3600']\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n    volumes:\n      - /custom\n")
            helpers.append((service, helper_file))
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
        consumer_file.write_text("services:\n  consumer:\n    image: " + consumer_tag + "\n" + "".join("    " + key + ": " + json.dumps(value) + "\n" for key, value in {**shared, "network_mode": "service:provider"}.items() if key != "image"))
        config_file = directory / "config.yaml"
        config_data = directory / "config-data"
        config_data.mkdir()
        (config_data / "settings.json").write_text("{}\n")
        config_file.write_text("services:\n  config-app:\n    image: " + config_image + "\n    command: [/config/settings.json]\n    network_mode: none\n    mem_limit: 64m\n    pids_limit: 32\n    labels:\n      homelab.smoke: " + owner + "\n    volumes:\n      - type: bind\n        source: " + str(config_data) + "\n        target: /config\n        read_only: true\n")
        config_file.write_text(config_file.read_text() + "      - type: bind\n        source: " + str(config_data / "settings.json") + "\n        target: /opt/homelab/logout-worker.js\n        read_only: true\n")
        config_file.write_text(config_file.read_text() + "    configs: [ordinary-settings]\n    secrets: [ordinary-token]\nconfigs:\n  ordinary-settings:\n    file: " + str(config_data / "settings.json") + "\nsecrets:\n  ordinary-token:\n    file: " + str(config_data / "settings.json") + "\n")
        config_file.write_text(config_file.read_text().replace("    command: [/config/settings.json]\n", "    command: [/config/settings.json]\n    healthcheck:\n      test: [CMD, /bin/bash, '-c', 'FOO=x coproc /vendor/server']\n      interval: 1s\n"))
        main_file.write_text(json.dumps({"include": [str(provider_file), str(consumer_file), str(overlay_file), str(config_file)] + [str(path) for _, path in helpers], "services": {"stopped": {**shared, "network_mode": "service:provider"}, "leaf": {**shared, "network_mode": "service:consumer"}}, "volumes": {"marker": {"labels": {"homelab.smoke": owner}}}}))
        base = ["/usr/bin/docker", "compose", "--project-directory", str(directory), "--project-name", owner, "--file", str(main_file)]
        def compose(args, timeout=120):
            return command(base + args, timeout=timeout)
        built_images = []
        consumer_tag_created = False
        def clear_pending_hooks():
            # Fixtures introduce hooks only for preflight. Never run them during
            # the later whole-project stop or cleanup.
            for name, source_file in helpers:
                if name in ("post-hook-helper", "pre-hook-helper", "hook-environment-helper", "helper-hook"):
                    source_file.write_text("\n".join(line for line in source_file.read_text().splitlines() if not line.startswith(("    post_start:", "    pre_stop:"))) + "\n")
        try:
            build_directory = directory / "image"
            build_directory.mkdir()
            (build_directory / "Dockerfile").write_text("FROM postgres:18\nENTRYPOINT [\"python\"]\nCMD [\"/vendor/app.py\"]\n")
            # BuildKit needs a writable client state directory; scope it to this
            # disposable fixture instead of the updater's /nonexistent HOME.
            command(["/usr/bin/docker", "build", "--pull=false", "--network=none", "--label", "homelab.smoke=" + owner, "--tag", inherited_image, str(build_directory)], environment={"HOME": str(build_directory)})
            built_images.append(inherited_image)
            command(["/usr/bin/docker", "tag", image["Id"], consumer_tag])
            consumer_tag_created = True
            (build_directory / "server").write_text('#!/bin/sh\ntest -f "$1" || exit 1\nexec /bin/sleep 3600\n')
            (build_directory / "coproc").write_text('#!/bin/sh\nexit 0\n')
            (build_directory / "Dockerfile").write_text('FROM postgres:18\nCOPY --chmod=755 server /vendor/server\nCOPY --chmod=755 coproc /vendor/coproc\nENV PATH=/vendor:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nENTRYPOINT ["/vendor/server"]\n')
            command(["/usr/bin/docker", "build", "--pull=false", "--network=none", "--label", "homelab.smoke=" + owner, "--tag", config_image, str(build_directory)], environment={"HOME": str(build_directory)})
            built_images.append(config_image)
            (build_directory / "Dockerfile").write_text('FROM postgres:18\nENTRYPOINT ["/bin/sleep"]\nCMD ["3600"]\nHEALTHCHECK CMD ["/bin/sh", "/custom/start"]\n')
            command(["/usr/bin/docker", "build", "--pull=false", "--network=none", "--label", "homelab.smoke=" + owner, "--tag", health_image, str(build_directory)], environment={"HOME": str(build_directory)})
            built_images.append(health_image)
            (build_directory / "Dockerfile").write_text('FROM postgres:18\nSHELL ["/custom/shell", "-c"]\nENTRYPOINT ["/bin/sleep"]\nCMD ["3600"]\n')
            command(["/usr/bin/docker", "build", "--pull=false", "--network=none", "--label", "homelab.smoke=" + owner, "--tag", shell_image, str(build_directory)], environment={"HOME": str(build_directory)})
            built_images.append(shell_image)
            (build_directory / "Dockerfile").write_text('FROM postgres:18\nRUN mkdir -p /vendor /custom/dir && ln -s /custom/dir /alias && ln -s /alias/../start /vendor/start\nENTRYPOINT ["/bin/sleep"]\nCMD ["3600"]\n')
            command(["/usr/bin/docker", "build", "--pull=false", "--network=none", "--label", "homelab.smoke=" + owner, "--tag", symlink_image, str(build_directory)], environment={"HOME": str(build_directory)})
            built_images.append(symlink_image)
            symlink_file = directory / "symlink-helper.yaml"
            symlink_file.write_text(symlink_file.read_text().replace(original, symlink_image))
            # Compose 2.38 --wait incorrectly requires State.Health even when an
            # inherited image healthcheck is explicitly disabled. Start this
            # exact fixture separately and assert its effective disabled state;
            # all remaining fixtures retain Compose's normal readiness checks.
            disabled_health_service = "inherited-health-helper"
            compose(["up", "--detach", "--no-build", "--pull", "never", disabled_health_service])
            disabled_health = json.loads(command(["/usr/bin/docker", "inspect", owner + "-" + disabled_health_service + "-1"]))[0]
            assert disabled_health["Config"]["Labels"]["homelab.smoke"] == owner
            assert disabled_health["Config"]["Healthcheck"]["Test"] == ["NONE"]
            assert disabled_health["State"]["Status"] == "running" and not disabled_health["State"].get("Health")
            wait_services = [name for name in compose(["config", "--services"]).split() if name != disabled_health_service]
            # Bound setup fan-out as the owned fixture set grows. Compose still
            # starts required dependencies and each group retains the original
            # command deadline and twenty-second readiness check.
            for offset in range(0, len(wait_services), 8):
                compose(["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "20", *wait_services[offset:offset + 8]])
            # Change Compose only, keeping the live startup vector on /bin/sleep.
            # Both pending extensionless scripts and cwd module execution must
            # fail before a pull, pin edit or replacement of the current container.
            for service, helper_file in helpers:
                if service in ("brace-helper", "sed-helper", "stack-helper"):
                    invocation = {
                        "brace-helper": ["/bin/bash", "-c", "/{custom,vendor}/start"],
                        "sed-helper": ["sed", "-n", "-e", "1e /custom/start", "/etc/hostname"],
                        "stack-helper": ["/bin/bash", "-c", "pushd /custom; ./start"],
                    }[service]
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: " + json.dumps(invocation) + "\n    command: []"))
                elif service == "pending-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, /custom/start]"))
                elif service == "module-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "working_dir: /custom\n    entrypoint: [python]\n    command: ['-m', app]"))
                elif service == "inherited-helper":
                    # Remove the OLD container override: the image supplies Python,
                    # while pending Compose supplies only module args and cwd.
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "working_dir: /custom\n    command: ['-m', app]"))
                elif service == "option-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "command: ['-X', dev, '-W', error, /custom/app.py]"))
                elif service == "env-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/usr/bin/env]\n    command: ['-u', FOO, /custom/start]"))
                elif service == "assignment-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, '-c']\n    command: ['FOO=x /custom/start']"))
                elif service in ("config-helper", "secret-helper"):
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, /custom/start]"))
                elif service == "newline-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, '-c']\n    command: " + json.dumps(["/vendor/prep\n/custom/start"])))
                elif service == "volume-helper":
                    command(["/usr/bin/docker", "exec", owner + "-volume-helper-1", "/bin/sh", "-ec", "printf '# Synthetic code, never executed.\\n' > /custom/start; chmod 644 /custom/start"])
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, /custom/start]"))
                elif service == "expansion-helper":
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, '-c']\n    command: " + json.dumps(['/vendor/prep "$(/custom/start)"'])))
                elif service in ("compound-helper", "conditional-helper"):
                    expression = "( /custom/start )" if service == "compound-helper" else "i\\\nf /custom/start; then /bin/sleep 3600; fi"
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/sh, '-c']\n    command: " + json.dumps([expression])))
                elif service == "compound-health-helper":
                    helper_file.write_text(helper_file.read_text() + "    healthcheck:\n      test: " + json.dumps(["CMD-SHELL", "{ /custom/start; }"]) + "\n")
                elif service in ("dispatch-helper", "dispatch-cwd-helper"):
                    expression = "command -p -- /custom/start" if service == "dispatch-helper" else "builtin command cd -- /custom && ./start"
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: [/bin/bash, '-c']\n    command: " + json.dumps([expression])))
                elif service == "dispatch-health-helper":
                    helper_file.write_text(helper_file.read_text() + "    healthcheck:\n      test: " + json.dumps(["CMD", "/bin/bash", "-c", "builtin command /custom/start"]) + "\n")
                elif service in ("launcher-helper", "shell-option-helper", "trap-helper", "jvm-helper"):
                    invocation = {
                        "launcher-helper": ["/usr/bin/nice", "-n", "5", "/custom/start"],
                        "shell-option-helper": ["/bin/bash", "-O", "extglob", "/custom/start"],
                        "trap-helper": ["/bin/sh", "-c", "trap /custom/start EXIT; /bin/sleep 3600"],
                        "jvm-helper": ["java", "-jar", "/custom/app.jar"],
                    }[service]
                    helper_file.write_text(helper_file.read_text().replace("entrypoint: [/bin/sleep]\n    command: ['3600']", "entrypoint: " + json.dumps(invocation) + "\n    command: []"))
                elif service in ("path-helper", "expanded-script-helper", "runtime-option-helper"):
                    selected = {
                        "path-helper": ["/bin/sh", "-c", "start"],
                        "expanded-script-helper": ["/bin/sh", "-c", 'python "$$SCRIPT"'],
                        "runtime-option-helper": ["node", "--require=/custom/start", "/vendor/app.js"],
                    }[service]
                    helper_file.write_text(helper_file.read_text().replace("    entrypoint: [/bin/sleep]\n    command: ['3600']", "    entrypoint: " + json.dumps(selected) + "\n    command: []\n    environment:\n      PATH: /custom:/usr/bin:/bin\n      SCRIPT: /custom/start"))
                elif service in ("ruby-option-helper", "hash-helper", "exec-arg-helper", "init-arg-helper"):
                    selected = {
                        "ruby-option-helper": ["ruby", "-r/custom/start", "/vendor/app.rb"],
                        "hash-helper": ["/bin/bash", "-c", "hash -p /custom/start run; run"],
                        "exec-arg-helper": ["/bin/bash", "-c", "exec -a synthetic /custom/start"],
                        "init-arg-helper": ["tini", "-p", "SIGTERM", "--", "/custom/start"],
                    }[service]
                    helper_file.write_text(helper_file.read_text().replace("    entrypoint: [/bin/sleep]\n    command: ['3600']", "    entrypoint: " + json.dumps(selected) + "\n    command: []"))
                elif service in ("volumes-from-helper", "external-volumes-helper"):
                    reference = "volume-helper:ro" if service == "volumes-from-helper" else "container:" + owner + "-volume-helper-1:ro"
                    helper_file.write_text(helper_file.read_text().replace("    entrypoint: [/bin/sleep]\n    command: ['3600']", "    entrypoint: [/custom/start]\n    command: []") + "    volumes_from: " + json.dumps([reference]) + "\n")
                    effective_service = json.loads(compose(["config", "--format", "json"]))["services"][service]
                    assert effective_service.get("volumes_from") and not effective_service.get("volumes")
                    # The running container has not inherited this mount yet.
                    live = json.loads(command(["/usr/bin/docker", "inspect", owner + "-" + service + "-1"]))[0]
                    assert live["Config"]["Labels"]["homelab.smoke"] == owner
                    assert not any(mount["Destination"] == "/custom" for mount in live["Mounts"])
                elif service == "coproc-helper":
                    helper_file.write_text(helper_file.read_text().replace("    entrypoint: [/bin/sleep]\n    command: ['3600']", "    entrypoint: [/bin/bash, '-c']\n    command: ['coproc /custom/start']"))
                elif service == "coproc-health-helper":
                    helper_file.write_text(helper_file.read_text() + "    healthcheck:\n      test: " + json.dumps(["CMD", "/bin/bash", "-c", "co\\\nproc /custom/start"]) + "\n")
                elif service == "builtin-loader-helper":
                    helper_file.write_text(helper_file.read_text().replace("    entrypoint: [/bin/sleep]\n    command: ['3600']", "    entrypoint: [/bin/bash, '-c']\n    command: ['enable -f /custom/plugin.so worker; worker']"))
                elif service == "helper-hook":
                    helper_file.write_text(helper_file.read_text() + "    post_start: " + json.dumps([{"command": ["node", "/opt/homelab/logout-worker.js"]}]) + "\n")
                elif service in ("alias-helper", "python-inline-helper", "awk-helper", "find-helper", "module-cli-helper", "make-helper", "cdpath-helper", "symlink-helper", "stdin-helper", "history-helper", "helper-entrypoint", "variable-helper"):
                    invocation = {
                        "alias-helper": ["/bin/bash", "-O", "expand_aliases", "-c", "alias run=/custom/start\nrun"],
                        "python-inline-helper": ["python", "-Ic", "exec(open('/custom/start').read())"],
                        "awk-helper": ["awk", "-f", "/custom/start"],
                        "find-helper": ["find", "/tmp", "-execdir", "/custom/start", "{}", ";"],
                        "module-cli-helper": ["python", "-m", "doctest", "/custom/app.py"],
                        "make-helper": ["make", "-f", "/custom/Makefile"],
                        "cdpath-helper": ["/bin/sh", "-c", "CDPATH=/custom; cd app; ./start"],
                        "symlink-helper": ["/alias/../start"],
                        "stdin-helper": ["/bin/sh", "-c", "cat /custom/start | sh"],
                        "history-helper": ["/bin/bash", "-c", "history -r /custom/commands; fc -s"],
                        "helper-entrypoint": ["node", "/opt/homelab/logout-worker.js"],
                        "variable-helper": ["/bin/bash", "-c", "printf -vPATH /custom; start"],
                    }[service]
                    helper_file.write_text(helper_file.read_text().replace("    entrypoint: [/bin/sleep]\n    command: ['3600']", "    entrypoint: " + json.dumps(invocation) + "\n    command: []"))
                elif service == "custom-shell-helper":
                    live = json.loads(command(["/usr/bin/docker", "inspect", owner + "-" + service + "-1"]))[0]
                    # Some Engine versions omit image SHELL from live Config.
                    # Pending qualification must still use immutable image defaults,
                    # not infer them from that old container or a mutable tag.
                    defaults = json.loads(command(["/usr/bin/docker", "image", "inspect", live["Image"]]))[0]
                    assert defaults["Config"]["Shell"] == ["/custom/shell", "-c"]
                    assert live["Config"]["Healthcheck"]["Test"] == ["CMD", "/bin/true"]
                    helper_file.write_text(helper_file.read_text().replace("test: [CMD, /bin/true]", "test: [CMD-SHELL, /bin/true]"))
                elif service == "loader-helper":
                    helper_file.write_text(helper_file.read_text().replace("    command: ['3600']", "    command: ['3600']\n    environment:\n      LD_PRELOAD: /custom/libapp.so"))
                elif service in ("post-hook-helper", "pre-hook-helper", "hook-environment-helper"):
                    kind = "pre_stop" if service == "pre-hook-helper" else "post_start"
                    hook = {"command": ["./start"], "working_dir": "/custom"}
                    if service == "hook-environment-helper":
                        hook = {"command": ["/bin/true"], "environment": {"LD_PRELOAD": "/custom/libapp.so"}}
                    helper_file.write_text(helper_file.read_text() + "    " + kind + ": " + json.dumps([hook]) + "\n")
                elif service == "health-helper":
                    helper_file.write_text(helper_file.read_text() + "    healthcheck:\n      test: [CMD, /bin/sh, /custom/start]\n")
                elif service == "inherited-health-helper":
                    helper_file.write_text(helper_file.read_text().replace("    healthcheck:\n      disable: true\n", "    healthcheck:\n      interval: 1s\n"))
            compose(["stop", "stopped"])
            before = {service: remote.namespace_snapshot(owner + "-" + service + "-1") for service in ("provider", "consumer", "stopped", "leaf")}
            command(["/usr/bin/docker", "exec", before["consumer"][0], "/bin/sh", "-ec", "printf persistent > /marker/probe"])
            driver = {"kind": "docker", "name": owner + "-provider-1", "project": owner, "service": "provider", "directory": str(directory), "file": str(main_file), "imageFile": str(provider_file), "namespaceDependents": ["consumer", "stopped", "leaf"]}
            item = {"id": "docker:" + before["provider"][0], "image": original, "installed": image["Id"], "available": image["Id"], "availableImage": candidate}
            # Real image defaults and Compose config must qualify a positional
            # data operand. Stop at pull: the synthetic image is intentionally
            # local-only, and is never published or pulled from a real registry.
            class PreflightQualified(Exception):
                pass
            config_name = owner + "-config-app-1"
            config_before = remote.namespace_snapshot(config_name)
            def stop_after_preflight(arguments, **options):
                if arguments[1] == "pull":
                    raise PreflightQualified()
                return command(arguments, **options)
            try:
                remote.command = stop_after_preflight
                remote.docker_update({**driver, "name": config_name, "service": "config-app", "imageFile": str(config_file), "namespaceDependents": []}, {**item, "id": "docker:" + config_before[0], "image": config_image, "installed": config_before[3], "availableImage": "docker.io/homelab-fixtures/" + owner + ":candidate@sha256:" + "a" * 64})
                raise AssertionError("The preflight boundary was not reached")
            except PreflightQualified:
                pass
            finally:
                remote.command = command
            assert remote.namespace_snapshot(config_name) == config_before
            assert config_image in config_file.read_text()
            for overlay_service, overlay_source in [("overlay", overlay_file)] + helpers:
                overlay_name = owner + "-" + overlay_service + "-1"
                overlay_before = remote.namespace_snapshot(overlay_name)
                try:
                    def no_pull(arguments, **options):
                        assert arguments[1] != "pull", "Preflight must refuse mounted code before pull"
                        return command(arguments, **options)
                    remote.command = no_pull
                    overlay_item = {**item, "id": "docker:" + overlay_before[0]}
                    if overlay_service in ("inherited-helper", "option-helper"):
                        overlay_item.update(image=inherited_image, installed=overlay_before[3], available=overlay_before[3], availableImage="docker.io/homelab-fixtures/" + owner + ":candidate@sha256:" + "a" * 64)
                    elif overlay_service == "inherited-health-helper":
                        overlay_item.update(image=health_image, installed=overlay_before[3], available=overlay_before[3], availableImage="docker.io/homelab-fixtures/" + owner + ":candidate@sha256:" + "a" * 64)
                    elif overlay_service == "custom-shell-helper":
                        overlay_item.update(image=shell_image, installed=overlay_before[3], available=overlay_before[3], availableImage="docker.io/homelab-fixtures/" + owner + ":candidate@sha256:" + "a" * 64)
                    elif overlay_service == "symlink-helper":
                        overlay_item.update(image=symlink_image, installed=overlay_before[3], available=overlay_before[3], availableImage="docker.io/homelab-fixtures/" + owner + ":candidate@sha256:" + "a" * 64)
                    remote.docker_update({**driver, "name": overlay_name, "service": overlay_service, "imageFile": str(overlay_source), "namespaceDependents": []}, overlay_item)
                    raise AssertionError("An obsolete executable overlay was allowed through the updater")
                except remote.UpdateRefusal as error:
                    assert error.reason == "local_code_override"
                finally:
                    remote.command = command
                assert remote.namespace_snapshot(overlay_name) == overlay_before
                assert overlay_item["image"] in overlay_source.read_text() and overlay_item["availableImage"] not in overlay_source.read_text()
            # Qualify every planned consumer, including a stopped peer and a
            # transitive leaf, before pulling the root or changing any pin.
            pristine_main, pristine_consumer = main_file.read_bytes(), consumer_file.read_bytes()
            stable_peers = {name: remote.namespace_snapshot(row[0]) for name, row in before.items()}
            for selected, mode in (("consumer", "startup"), ("leaf", "health"), ("stopped", "hook"), ("leaf", "relative-link"), ("consumer", "append"), ("consumer", "unset-function"), ("consumer", "tar"), ("consumer", "loader-config"), ("consumer", "manifest")):
                try:
                    config = json.loads(pristine_main)
                    if selected == "consumer":
                        peer_file = consumer_file
                        peer = {**shared, "image": consumer_tag, "network_mode": "service:provider"}
                    else:
                        peer_file = main_file
                        peer = config["services"][selected]
                    peer["volumes"] = ["marker:/marker", "/custom"]
                    if mode in ("append", "unset-function"):
                        peer["entrypoint"] = ["/bin/bash", "-c"]
                        peer["command"] = ["PATH+=:/custom; run" if mode == "append" else "unset -f PATH; run"]
                        peer["environment"] = {"PATH": "/custom:/usr/bin:/bin" if mode == "unset-function" else "/usr/bin:/bin"}
                    elif mode == "tar":
                        peer["entrypoint"] = ["tar"]
                        peer["command"] = ["-I", "/custom/start", "-xf", "/data/archive"]
                    elif mode in ("loader-config", "manifest"):
                        source = directory / (mode + ".input")
                        source.write_text("" if mode == "loader-config" else '{"main":"../custom/start.js"}')
                        peer["volumes"].append({"type": "bind", "source": str(source), "target": "/etc/ld.so.preload" if mode == "loader-config" else "/app/package.json", "read_only": True})
                        if mode == "manifest":
                            peer["entrypoint"], peer["command"], peer["working_dir"] = ["node"], ["."], "/app"
                    if mode == "startup":
                        peer["entrypoint"], peer["command"] = ["/custom/start"], []
                    elif mode == "health":
                        peer["healthcheck"] = {"test": ["CMD", "sed", "-n", "-e", "1e /custom/start", "/etc/hostname"]}
                    elif mode == "hook":
                        peer["pre_stop"] = [{"command": ["/custom/start"]}]
                    elif mode == "relative-link":
                        # The consumer uses the same immutable image as the root.
                        # /bin/sh is a real relative link to dash in this image.
                        peer["entrypoint"], peer["command"] = ["/bin/sh", "/custom/start"], []
                    peer_file.write_text(json.dumps({"services": {selected: peer}} if selected == "consumer" else config))
                    def refuse_peer_pull(arguments, **options):
                        assert arguments[1] != "pull", "Consumer code must refuse before the root pull"
                        return command(arguments, **options)
                    remote.command = refuse_peer_pull
                    try:
                        remote.docker_update(driver, item)
                        raise AssertionError("Namespace consumer mounted code passed preflight")
                    except remote.UpdateRefusal as error:
                        assert error.reason == "local_code_override"
                finally:
                    remote.command = command
                    # Restore pending hooks before any later lifecycle/cleanup.
                    main_file.write_bytes(pristine_main)
                    consumer_file.write_bytes(pristine_consumer)
                assert {name: remote.namespace_snapshot(row[0]) for name, row in before.items()} == stable_peers
                assert original in provider_file.read_text() and candidate not in provider_file.read_text()
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
            original_progress = remote.progress
            tag_moved = False
            def racing_progress(stage, *args, **kwargs):
                nonlocal tag_moved
                if stage == "installing":
                    command(["/usr/bin/docker", "tag", inherited_image, consumer_tag])
                    tag_moved = True
                return original_progress(stage, *args, **kwargs)
            try:
                remote.progress = racing_progress
                assert remote.docker_update(driver, item) == image["Id"]
            except RuntimeError:
                for service in before:
                    current = remote.namespace_snapshot(owner + "-" + service + "-1")
                    if current[11] != before[service][11]:
                        print(json.dumps({"fixture": service, "mounts_before": before[service][11], "mounts_after": current[11]}))
                raise
            finally:
                remote.progress = original_progress
            assert tag_moved
            after = {service: remote.namespace_snapshot(owner + "-" + service + "-1") for service in before}
            assert after["provider"][0] != before["provider"][0]
            assert after["consumer"][0] != before["consumer"][0]
            assert after["consumer"][8] == "container:" + after["provider"][0]
            assert after["stopped"][8] == "container:" + after["provider"][0]
            assert after["stopped"][4] == "created"
            assert after["consumer"][2:4] == [consumer_tag + "@" + digest, image["Id"]]
            assert consumer_tag in consumer_file.read_text() and "@" not in consumer_file.read_text()
            assert command(["/usr/bin/docker", "image", "inspect", "--format", "{{.Id}}", consumer_tag]) != image["Id"]
            assert command(["/usr/bin/docker", "exec", after["consumer"][0], "cat", "/marker/probe"]) == "persistent"
            net = lambda identity: command(["/usr/bin/docker", "exec", identity, "readlink", "/proc/self/ns/net"])
            assert net(after["provider"][0]) == net(after["consumer"][0])
            consumer_driver = {**driver, "name": owner + "-consumer-1", "service": "consumer", "imageFile": str(consumer_file), "namespaceDependents": ["leaf"]}
            consumer_item = {**item, "id": "docker:" + after["consumer"][0], "image": after["consumer"][2]}
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
            clear_pending_hooks()
            compose(['stop', '--timeout', '5'])
            current = remote.namespace_snapshot(owner + '-provider-1')
            stopped_item = {**item, 'id': 'docker:' + current[0], 'image': candidate, 'availableImage': 'docker.io/library/postgres:18-bookworm@' + digest}
            assert remote.docker_update(driver, stopped_item) == image['Id']
            assert all(remote.namespace_snapshot(owner + '-' + service + '-1')[4] == 'created' for service in before)
            assert not list(directory.glob(".homelab-update-*"))
            print("PASS: unmocked Docker pull/inspect/Compose updater, exact pins, external-consumer refusal, baseline/post-update health failures, provider and consumer updates, retained data and stopped-project preservation.")
        finally:
            clear_pending_hooks()
            ids = compose(["ps", "--all", "--quiet"]).split()
            for identity in ids:
                assert command(["/usr/bin/docker", "inspect", "--format", '{{index .Config.Labels "homelab.smoke"}}', identity]) == owner
            compose(["down", "--volumes", "--timeout", "5"])
            if consumer_tag_created:
                tagged = json.loads(command(["/usr/bin/docker", "image", "inspect", consumer_tag]))[0]
                assert tagged["Id"] == image["Id"] or tagged["Config"]["Labels"].get("homelab.smoke") == owner
                command(["/usr/bin/docker", "image", "rm", consumer_tag])
            for fixture_image in built_images:
                assert command(["/usr/bin/docker", "image", "inspect", "--format", '{{index .Config.Labels "homelab.smoke"}}', fixture_image]) == owner
                command(["/usr/bin/docker", "image", "rm", fixture_image])


if __name__ == "__main__":
    main()
