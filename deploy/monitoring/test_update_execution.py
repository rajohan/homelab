"""Exercise updater safety against synthetic files and replaced commands, never a live daemon."""
import copy
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import tarfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "apps/dashboard/src/server/integrations/updates/remote.py"
SPEC = importlib.util.spec_from_file_location("update_execution_fixture", SOURCE)
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)
exec(compile(SOURCE.with_name("docker_dependencies.py").read_text(), str(SOURCE.with_name("docker_dependencies.py")), "exec"), remote.__dict__)
exec(compile(SOURCE.with_name("native.py").read_text(), str(SOURCE.with_name("native.py")), "exec"), remote.__dict__)
exec(compile(SOURCE.with_name("binary.py").read_text(), str(SOURCE.with_name("binary.py")), "exec"), remote.__dict__)
exec(compile(SOURCE.with_name("toolchain.py").read_text(), str(SOURCE.with_name("toolchain.py")), "exec"), remote.__dict__)


class UpdateExecutionTests(unittest.TestCase):
    """Cover exact image pins, source fencing, package boundaries and private error handling."""

    def test_compose_startup_inherits_only_omitted_or_null_image_defaults(self):
        defaults = {"entrypoint": ["python"], "command": ["/vendor/app.py"], "working_dir": "/vendor"}
        for overrides in ({}, {"entrypoint": None, "command": None, "working_dir": None}):
            self.assertEqual(remote.compose_startup(overrides, defaults), defaults)
        for empty in ([], ""):
            self.assertEqual(remote.compose_startup({"entrypoint": empty}, defaults), {**defaults, "entrypoint": empty, "command": []})
            self.assertEqual(remote.compose_startup({"command": empty}, defaults), {**defaults, "command": empty})
        for entrypoint in (None, ["python"], "python"):
            service = {"entrypoint": entrypoint, "command": ["-m", "app"], "working_dir": "/custom", "volumes": [{"type": "bind", "target": "/custom"}]}
            with self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts(service, remote.compose_startup(service, defaults))
        service = {"working_dir": "/custom", "volumes": [{"type": "bind", "target": "/custom"}]}
        with self.assertRaises(remote.UpdateRefusal):
            remote.verify_code_mounts(service, remote.compose_startup(service, defaults))

    def test_compose_positional_data_inherits_image_entrypoint(self):
        defaults = {"entrypoint": ["/vendor/server"], "command": [], "working_dir": "/"}
        for overrides in ({}, {"entrypoint": None}):
            service = {**overrides, "command": ["/config/settings.json"], "volumes": [{"type": "bind", "target": "/config"}]}
            remote.verify_code_mounts(service, remote.compose_startup(service, defaults))
        for entrypoint in ([], ""):
            service = {"entrypoint": entrypoint, "command": ["/custom/start"], "volumes": [{"type": "bind", "target": "/custom"}]}
            with self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts(service, remote.compose_startup(service, defaults))

    def test_compose_config_secret_startup_targets(self):
        for kind, base in (("configs", "/"), ("secrets", "/run/secrets/")):
            for entry, target in (("startup", base + "startup"),
                                  ({"source": "startup"}, base + "startup"),
                                  ({"source": "startup", "target": "/custom/start"}, "/custom/start"),
                                  ({"source": "startup", "target": "start"}, base + "start")):
                with self.subTest(kind=kind, entry=entry), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts({kind: [entry]}, {"entrypoint": ["/bin/sh", target]})

    def test_compose_config_secret_data_is_not_read_or_blocked(self):
        for kind, base in (("configs", "/"), ("secrets", "/run/secrets/")):
            with self.subTest(kind=kind), patch.object(Path, "read_text", side_effect=AssertionError("Contents must not be read")), patch.object(Path, "read_bytes", side_effect=AssertionError("Contents must not be read")):
                service = {kind: ["settings", {"source": "credential", "target": "/config/token"}]}
                remote.verify_code_mounts(service, {"entrypoint": ["/vendor/server"], "command": [base + "settings", "/config/token"]})
                remote.verify_code_mounts(service, {"entrypoint": ["python", "/vendor/server.py"], "command": ["--token-file", "/config/token"], "working_dir": "/vendor"})

    def test_compose_config_secret_code_suffixes_remain_blocked(self):
        for kind in ("configs", "secrets"):
            for target in ("/custom/plugin.py", "/usr/local/lib/python3.13/site-packages/plugin", "/app/lib/module"):
                with self.subTest(kind=kind, target=target), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts({kind: [{"source": "code", "target": target}]}, {"entrypoint": ["/vendor/server"]})

    def test_runtime_library_directory_binds_are_code(self):
        for destination in ("/usr/local/lib/python3.13/site-packages", "/usr/lib/python3/dist-packages", "/usr/local/lib/node_modules", "/usr/share/nodejs", "/usr/share/php", "/usr/lib64", "/lib", "/usr/share/ruby/vendor_ruby"):
            with self.subTest(destination=destination), self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts({"entrypoint": ["python"], "command": ["/vendor/app.py"], "volumes": [{"type": "bind", "target": destination}]})
        remote.verify_code_mounts({"entrypoint": ["/vendor/server"], "volumes": [{"type": "bind", "target": "/usr/share/zoneinfo"}, {"type": "bind", "target": "/usr/local/library-data"}]})

    def test_non_bind_startup_mounts_are_not_image_owned(self):
        for kind in ("volume", "tmpfs"):
            for target, entrypoint in (("/custom", ["/custom/start"]), ("/usr/local/lib/python3.13/site-packages", ["/vendor/server"])):
                with self.subTest(kind=kind, target=target), patch.object(Path, "stat", side_effect=AssertionError("Non-bind sources are not host paths")), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts({"entrypoint": entrypoint, "volumes": [{"type": kind, "source": "synthetic-volume", "target": target}]})

    def test_non_bind_data_mounts_remain_eligible(self):
        for kind in ("volume", "tmpfs"):
            for destination in ("/config", "/var/lib/postgresql/data", "/app/data"):
                with self.subTest(kind=kind, destination=destination), patch.object(Path, "stat", side_effect=AssertionError("Non-bind sources are not host paths")):
                    remote.verify_code_mounts({"entrypoint": ["/vendor/server"], "command": ["--data", destination], "volumes": [{"type": kind, "source": "synthetic-volume", "target": destination}]})

    def test_healthcheck_mounts_use_effective_commands(self):
        for kind in ("bind", "volume"):
            for check in (["CMD", "/custom/check"], ["CMD-SHELL", "/vendor/prep; /custom/check"], ["CMD-SHELL", '/vendor/check "$(/custom/check)"']):
                service = {"entrypoint": ["/vendor/server"], "volumes": [{"type": kind, "target": "/custom"}]}
                defaults = {"entrypoint": ["/vendor/server"], "healthcheck": {"Test": check}}
                for override in ({}, {"healthcheck": None}, {"healthcheck": {"interval": "1s"}}, {"healthcheck": {"test": check}}):
                    with self.subTest(kind=kind, check=check, override=override), self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts({**service, **override}, remote.compose_startup(override, defaults))
                for override in ({"disable": True}, {"test": ["NONE"]}, {"test": ["CMD", "/vendor/check", "--data", "/custom/config"]}):
                    remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": override}, defaults))

    def test_shell_expansion_without_mounts_is_not_a_code_overlay(self):
        remote.verify_code_mounts({"entrypoint": ["sh", "-c"], "command": ['/vendor/check "$(date)"']})

    def test_startup_positions_match_discovery_corpus(self):
        cases = json.loads((SOURCE.parents[6] / "scripts/fixtures/dockerStartup.json").read_text())
        for scenario in cases:
            with self.subTest(name=scenario["name"]):
                paths = remote.startup_code_paths(scenario)
                mounted = scenario["mount"]
                self.assertEqual(paths is None or any(value == mounted or value.startswith(mounted + "/") for value in paths), scenario["blocked"])
                self.assertNotIn("SYNTHETIC_PRIVATE", "\n".join(paths or []))
                service = {**scenario, "volumes": [{"type": "bind", "target": mounted}]}
                if scenario["blocked"]:
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service)
                else:
                    remote.verify_code_mounts(service)

    def docker_fixture(self, mode="running", mutate=False, fail=False, with_environment=False, manifest_store=False, wrong_pull=False, new_consumer=None):
        with tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
            directory = Path(temporary).resolve()
            source = directory / "compose.yaml"
            old = "example/web:1.2.3@sha256:" + "a" * 64
            new = "docker.io/example/web:1.3.0@sha256:" + "b" * 64
            original = ("services:\n  web:\n    image: " + old + "\n    environment:\n      PRIVATE: synthetic-private-value\n").encode()
            source.write_bytes(original)
            driver = {"kind": "docker", "name": "demo-web-1", "project": "demo", "service": "web", "directory": str(directory), "file": str(source), "imageFile": str(source)}
            if with_environment:
                driver["environment"] = {"command": ["/fixture/environment", "json"], "variables": ["PRIVATE"]}
            item = {"id": "docker:" + "c" * 64, "image": old, "installed": "sha256:" + "d" * 64, "available": "sha256:" + "e" * 64, "availableImage": new}
            if manifest_store:
                item.update(installed=old.split("@")[1], available=new.split("@")[1])
            calls = []
            installed = False
            pulled = False

            def command(arguments, timeout=120, environment=None, output_limit=2_000_000):
                nonlocal installed, pulled
                calls.append(arguments)
                if arguments[0] == "/fixture/environment":
                    self.assertIsNone(environment)
                    self.assertEqual(output_limit, 65_536)
                    return json.dumps({"PRIVATE": "synthetic-private-value", "DOCKER_HOST": "http://untrusted.invalid", "UNSELECTED": "not-forwarded"})
                if arguments[1] == "compose" and with_environment:
                    self.assertEqual(environment, {"PRIVATE": "synthetic-private-value", "COMPOSE_DISABLE_ENV_FILE": "1"})
                else:
                    self.assertIsNone(environment)
                if arguments[1] == "inspect":
                    if arguments[3].startswith('{"entrypoint":'):
                        self.assertEqual(arguments[4], 'c' * 64)
                        return json.dumps({"entrypoint": ["/vendor/web"], "command": None, "working_dir": "/"})
                    if arguments[3] == '{{json .State}}':
                        return json.dumps({'Status': mode, 'Health': {'Status': 'healthy'}})
                    if '{{.Id}}' in arguments[3]:
                        return 'c' * 64 + ' default' + ('\n' + 'f' * 64 + ' ' + ' '.join('container:' + 'c' * 64 if key == new_consumer else 'default' for key in remote.NAMESPACE_KEYS) if pulled and new_consumer else '')
                    if '{{json .Id}}' in arguments[3]:
                        values = ['c' * 64, '/demo-web-1', new if installed else old, item['available'] if installed else item['installed'], 'created' if installed and mode != 'running' else mode, 'fixture-start', 'demo', 'web', 'default', '', '', []]
                        return ','.join(json.dumps(value) for value in values)
                    values = ["/demo-web-1", new if installed else old, item["available"] if installed else item["installed"], "created" if installed and mode != "running" else mode, "demo", "web"]
                    return ",".join(json.dumps(value) for value in values)
                if arguments[1] == 'ps' or (arguments[1] == 'compose' and 'ps' in arguments):
                    return 'c' * 64
                if arguments[1:3] == ["image", "inspect"]:
                    if arguments[4].startswith('{"entrypoint":'):
                        return json.dumps({"entrypoint": ["/vendor/web"], "command": None, "working_dir": "/"})
                    return "sha256:" + "f" * 64 if wrong_pull else item["available"]
                if arguments[1] == "pull":
                    pulled = True
                    if mutate:
                        source.write_bytes(original + b"# External edit\n")
                    return "Downloaded"
                if "config" in arguments:
                    image = new if new in source.read_text() else old
                    return json.dumps({"services": {"web": {"image": image, "environment": {"PRIVATE": "synthetic-private-value"}}}})
                if "up" in arguments:
                    installed = True
                    if fail:
                        raise RuntimeError("Synthetic health failure")
                    return "Started"
                raise AssertionError("Unexpected command")

            with patch.object(remote, "command", side_effect=command), patch.object(remote, "progress"):
                if mutate or fail or wrong_pull or new_consumer:
                    with self.assertRaises(RuntimeError):
                        remote.docker_update(driver, item, True)
                else:
                    self.assertEqual(remote.docker_update(driver, item, True), item["available"])
            contents = source.read_bytes()
            if with_environment:
                self.assertEqual(sum(call[0] == "/fixture/environment" for call in calls), 1)
            self.assertIn(b"synthetic-private-value", contents)
            self.assertFalse(list(directory.glob(".homelab-update-*")))
            if wrong_pull or new_consumer:
                self.assertEqual(contents, original)
                self.assertFalse(any("up" in call for call in calls))
            elif mutate:
                self.assertEqual(contents, original + b"# External edit\n")
                self.assertFalse(any("up" in call for call in calls))
            else:
                self.assertIn(new.encode(), contents)
                action = next(call for call in calls if "up" in call)
                self.assertIn("--no-deps", action)
                self.assertIn("--no-build", action)
                self.assertIn("--no-start" if mode != "running" else "--wait", action)
                self.assertEqual(action[-1], "web")

    def test_running_image_update_persists_pin_and_waits_for_health(self):
        self.docker_fixture()

    def test_new_reverse_namespace_edges_during_pull_refuse_before_pin_or_stop(self):
        for namespace in remote.NAMESPACE_KEYS:
            with self.subTest(namespace=namespace):
                self.docker_fixture(new_consumer=namespace)

    def test_reverse_namespace_scan_remains_bounded_and_ignores_unrelated_containers(self):
        with patch.object(remote, 'command', return_value=' '.join(['a' * 64] * 501)):
            with self.assertRaisesRegex(RuntimeError, 'budget'):
                remote.verify_namespace_membership([['a' * 64]])
        with patch.object(remote, 'command', side_effect=['b' * 64, 'b' * 64 + ' container:' + 'c' * 64]):
            remote.verify_namespace_membership([['a' * 64]])

    def test_namespace_order_is_transitive_and_cycles_fail_before_writes(self):
        config = {'vpn': {}, 'proxy': {'network_mode': 'service:vpn'}, 'app': {'network_mode': 'service:proxy'}, 'other': {}}
        self.assertEqual(remote.namespace_services(config, 'vpn'), ['vpn', 'proxy', 'app'])
        config['vpn']['ipc'] = 'service:app'
        with self.assertRaisesRegex(RuntimeError, 'cycle'):
            remote.namespace_services(config, 'vpn')

    def test_changed_namespace_observations_prevent_mutation(self):
        with patch.object(remote, 'namespace_snapshot', return_value=['changed']):
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                remote.verify_namespace_plan([['old']])

    def test_namespace_preflight_validates_each_running_consumer_edge(self):
        for key, index in zip(remote.NAMESPACE_KEYS, (8, 9, 10)):
            services = {'root': {'image': 'fixture'}, 'middle': {'image': 'fixture', key: 'service:root'}, 'leaf': {'image': 'fixture', key: 'service:middle'}}
            for root_state in ('running', 'exited', 'created'):
                for middle_state in ('running', 'exited', 'created'):
                    for leaf_state in ('running', 'exited', 'created'):
                        with self.subTest(namespace=key, states=(root_state, middle_state, leaf_state)):
                            rows = {}
                            for identity, name, state in zip('abc', services, (root_state, middle_state, leaf_state)):
                                rows[name] = [identity * 64, '/' + name, 'fixture', 'sha256:' + 'd' * 64, state, 'fixture-start', 'demo', name, '', '', '', []]
                            rows['middle'][index] = 'container:' + rows['root'][0]
                            rows['leaf'][index] = 'container:' + rows['middle'][0]
                            by_id = {row[0]: row for row in rows.values()}
                            def compose(args):
                                self.assertEqual(args[:3], ['ps', '--all', '--quiet'])
                                return rows[args[-1]][0]
                            with patch.object(remote, 'namespace_snapshot', side_effect=lambda identity: by_id[identity]), patch.object(remote, 'command', return_value=''):
                                invalid = (middle_state == 'running' and root_state != 'running') or (leaf_state == 'running' and middle_state != 'running')
                                if invalid:
                                    with self.assertRaisesRegex(RuntimeError, 'stopped namespace provider'):
                                        remote.prepare_namespace_plan({'services': services}, {'project': 'demo', 'service': 'root', 'namespaceDependents': ['middle', 'leaf']}, compose)
                                else:
                                    self.assertEqual(remote.prepare_namespace_plan({'services': services}, {'project': 'demo', 'service': 'root', 'namespaceDependents': ['middle', 'leaf']}, compose), list(rows.values()))

    def test_namespace_stop_targets_only_running_consumers_in_reverse_order(self):
        plan = [[None] * 12 for _ in range(4)]
        for row, name, state in zip(plan, ['vpn', 'proxy', 'app', 'stopped'], ['running', 'running', 'running', 'exited']):
            row[7], row[4] = name, state
        calls = []
        with patch.object(remote, 'progress'):
            remote.stop_namespace_consumers(plan, 'vpn', lambda args, timeout: calls.append(args))
        self.assertEqual(calls, [['stop', '--timeout', '30', 'app', 'proxy']])

    def test_stopped_image_update_does_not_start_the_service(self):
        self.docker_fixture(mode="exited")

    def test_containerd_update_verifies_manifest_identity_and_preserves_stopped_state(self):
        self.docker_fixture(manifest_store=True)
        self.docker_fixture(manifest_store=True, mode="exited")

    def test_wrong_download_identity_is_rejected_before_editing_in_both_stores(self):
        self.docker_fixture(wrong_pull=True)
        self.docker_fixture(manifest_store=True, wrong_pull=True)

    def test_scoped_environment_is_loaded_once_and_only_passed_to_compose(self):
        self.docker_fixture(with_environment=True)

    def test_scoped_environment_preserves_stopped_state_and_source_fencing(self):
        self.docker_fixture(with_environment=True, mode="exited")
        self.docker_fixture(with_environment=True, mutate=True)

    def test_environment_rejects_missing_invalid_oversized_and_control_values(self):
        source = {"environment": {"command": ["/fixture/environment"], "variables": ["PRIVATE"]}}
        for value in ({}, [], {"PRIVATE": None}, {"PRIVATE": 3}, {"PRIVATE": "nul\x00byte"}, {"PRIVATE": "x" * 16_385}, {"PRIVATE": "ok", "unused": "x" * 65_536}):
            with self.subTest(value_type=type(value).__name__), patch.object(remote, "command", return_value=json.dumps(value)):
                with self.assertRaises(RuntimeError):
                    remote.compose_environment(source)
        for name in ("PATH", "HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PYTHONPATH", "BASH_ENV", "SHELLOPTS", "COMPOSE_FILE", "DOCKER_HOST", "LC_ALL", "ENV", "IFS", "bad-name"):
            with self.subTest(name=name), patch.object(remote, "command", return_value=json.dumps({name: "unused"})):
                with self.assertRaises(RuntimeError):
                    remote.compose_environment({"environment": {"command": ["/fixture/environment"], "variables": [name]}})

    def test_real_command_bounds_private_environment_output(self):
        script = "import os; print('ok' if os.environ.get('PRIVATE') == 'synthetic-private-value' else 'missing')"
        self.assertEqual(remote.command([sys.executable, "-c", script], environment={"PRIVATE": "synthetic-private-value"}), "ok")
        with self.assertRaisesRegex(RuntimeError, "budget"):
            remote.command([sys.executable, "-c", "print('synthetic-private-value' * 4000)"], output_limit=65_536)

    def test_external_compose_edit_is_not_overwritten(self):
        self.docker_fixture(mutate=True)

    def test_failed_readiness_does_not_blindly_rollback_application_data(self):
        self.docker_fixture(fail=True)

    def test_candidate_cannot_replace_the_image_repository(self):
        with patch.object(remote, "command") as command:
            with self.assertRaises(RuntimeError):
                remote.docker_update({}, {"image": "example/web:1.0.0", "availableImage": "ghcr.io/other/web:1.1.0@sha256:" + "a" * 64})
            command.assert_not_called()

    def test_atomic_replacement_rejects_a_symlink_and_keeps_the_target(self):
        with tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
            path = Path(temporary)
            actual = path / "actual.yaml"
            actual.write_bytes(b"original")
            link = path / "link.yaml"
            link.symlink_to(actual)
            with self.assertRaises(RuntimeError):
                remote.atomic_content(link, b"changed", b"original")
            self.assertEqual(actual.read_bytes(), b"original")

    def test_atomic_replacement_preserves_real_posix_acl_and_permissions(self):
        with tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
            path = Path(temporary).resolve() / "compose.yaml"
            path.write_bytes(b"original")
            acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", tag, permission, identity) for tag, permission, identity in [
                (1, 6, 0xffffffff), (2, 4, 12345), (4, 4, 0xffffffff), (16, 6, 0xffffffff), (32, 0, 0xffffffff)])
            os.setxattr(path, "system.posix_acl_access", acl)
            before = path.stat()
            remote.atomic_content(path, b"changed", b"original")
            after = path.stat()
            self.assertEqual(path.read_bytes(), b"changed")
            self.assertEqual(os.getxattr(path, "system.posix_acl_access"), acl)
            self.assertEqual((after.st_mode, after.st_uid, after.st_gid), (before.st_mode, before.st_uid, before.st_gid))
            self.assertNotEqual(after.st_ino, before.st_ino)
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_atomic_replacement_does_not_inherit_new_directory_access(self):
        with tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
            directory = Path(temporary).resolve()
            path = directory / "compose.yaml"
            path.write_bytes(b"original")
            path.chmod(0o600)
            acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", tag, permission, identity) for tag, permission, identity in [
                (1, 7, 0xffffffff), (2, 7, 12345), (4, 7, 0xffffffff), (16, 7, 0xffffffff), (32, 7, 0xffffffff)])
            os.setxattr(directory, "system.posix_acl_default", acl)
            remote.atomic_content(path, b"changed", b"original")
            self.assertEqual(os.listxattr(path), [])
            self.assertEqual(path.stat().st_mode & 0o7777, 0o600)

    def test_atomic_replacement_preserves_concurrent_acl_edits(self):
        with tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
            path = Path(temporary).resolve() / "compose.yaml"
            path.write_bytes(b"original")
            with patch.object(remote.os, "fsync", side_effect=lambda _descriptor: path.chmod(0o640)):
                with self.assertRaisesRegex(RuntimeError, "changed"):
                    remote.atomic_content(path, b"changed", b"original")
            self.assertEqual(path.read_bytes(), b"original")
            self.assertEqual(path.stat().st_mode & 0o7777, 0o640)
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_native_recipe_installs_exact_version_and_requires_health(self):
        calls = []
        def command(arguments, timeout=120):
            calls.append(arguments)
            return "1.2.3" if len(calls) == 1 else "1.3.0"
        driver = {"inspect": ["/fixture/app", "--version"], "install": ["/fixture/app", "update", "--version={version}"], "health": ["/fixture/app", "health"]}
        with patch.object(remote, "command", side_effect=command), patch.object(remote, "progress"):
            self.assertEqual(remote.native_update(driver, {"installed": "1.2.3", "available": "1.3.0"}), "1.3.0")
        self.assertEqual(calls[1], ["/fixture/app", "update", "--version=1.3.0"])
        self.assertEqual(calls[-1], driver["health"])

    def test_automatic_package_update_rejects_major_dependencies(self):
        def package(name, before, after):
            return types.SimpleNamespace(fullname=name, installed=types.SimpleNamespace(version=before), candidate=types.SimpleNamespace(version=after), marked_delete=False, _pkg=types.SimpleNamespace(selected_state=0), mark_install=lambda **_options: None)
        selected = package("demo", "1.2.3", "1.3.0")
        dependency = package("dependency", "1.0.0", "2.0.0")
        class Cache:
            broken_count = 0
            def __getitem__(self, name):
                return selected
            def get_changes(self):
                return [selected, dependency]
        modules = {"apt": types.SimpleNamespace(Cache=Cache), "apt_pkg": types.SimpleNamespace(SELSTATE_HOLD=2, version_compare=lambda after, before: (after > before) - (after < before))}
        with patch.dict(sys.modules, modules), patch.object(remote, "command") as command:
            with self.assertRaisesRegex(RuntimeError, "manual approval"):
                remote.apt_update({"id": "apt:demo", "installed": "1.2.3", "available": "1.3.0"}, True)
            command.assert_not_called()

    def test_package_already_updated_by_a_batch_dependency_is_verified_without_reinstallation(self):
        selected = types.SimpleNamespace(installed=types.SimpleNamespace(version="1.3.0"))
        class Cache:
            def __getitem__(self, name):
                self.assert_name = name
                return selected
        modules = {"apt": types.SimpleNamespace(Cache=Cache), "apt_pkg": types.SimpleNamespace()}
        with patch.dict(sys.modules, modules), patch.object(remote, "command") as command, patch.object(remote, "progress") as progress:
            self.assertEqual(remote.apt_update({"id": "apt:demo", "installed": "1.2.3", "available": "1.3.0"}, False), "1.3.0")
            command.assert_not_called()
            progress.assert_called_once_with("verifying")

    def test_failure_receipt_omits_updater_output_and_private_data(self):
        payload = {"driver": {"kind": "native", "inspect": [sys.executable, "-c", "raise Exception('synthetic-private-value')"]}, "item": {"installed": "1.0.0"}, "automatic": False}
        result = subprocess.run([sys.executable, str(SOURCE)], input=json.dumps(payload), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("synthetic-private-value", result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1]), {"complete": False})


class NativeRecipeTests(unittest.TestCase):
    """Exercise bundled vendor recipes with synthetic files, metadata and subprocesses."""

    def adguard_fixture(self, *, bad_hash=False, wrong_version=False, active=True, changed=False, special_mode=False, attributes=False, changed_metadata=False):
        with tempfile.TemporaryDirectory(prefix="homelab-native-fixture-") as temporary:
            directory = Path(temporary).resolve()
            binary = directory / "AdGuardHome"
            binary.write_bytes(b"old")
            binary.chmod(0o755)
            if special_mode:
                binary.chmod(0o4755)
            if attributes:
                os.setxattr(binary, "user.homelab-test", b"preserve me")
            (directory / "AdGuardHome.yaml").write_text("private fixture configuration")
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w:gz") as package:
                member = tarfile.TarInfo("AdGuardHome/AdGuardHome")
                member.size = 3
                package.addfile(member, io.BytesIO(b"new"))
                # A malicious unrelated path is never extracted.
                extra = tarfile.TarInfo("../../escape")
                extra.size = 3
                package.addfile(extra, io.BytesIO(b"bad"))
            content = archive.getvalue()
            driver = {"kind": "native", "release": "adguard-home", "recipe": {"application": "adguard-home", "binary": str(binary), "service": "AdGuardHome.service"}, "health": ["/fixture/health"]}
            item = {"installed": "0.107.0", "available": "0.107.1", "release": "adguard-home"}
            calls = []
            def run(args, **_options):
                calls.append(args)
                if args[0] == "/usr/bin/uname":
                    return "x86_64"
                if "--property=ActiveState" in args:
                    return "active" if active else "inactive"
                if args[-1] == "--version":
                    value = Path(args[0]).read_bytes()
                    return "AdGuard Home, version v" + ("0.107.0" if value == b"old" else "0.107.2" if wrong_version else "0.107.1")
                return ""
            def download(url, _limit):
                self.assertTrue(url.startswith("https://github.com/AdguardTeam/AdGuardHome/releases/download/v0.107.1/"))
                if url.endswith("checksums.txt"):
                    checksum = "a" * 64 if bad_hash else hashlib.sha256(content).hexdigest()
                    return (checksum + "  ./AdGuardHome_linux_amd64.tar.gz\n").encode()
                if changed:
                    binary.write_bytes(b"concurrent change")
                if changed_metadata:
                    os.setxattr(binary, "user.homelab-test", b"concurrent metadata")
                return content
            with patch.object(remote, "native_download", side_effect=download), patch.object(remote, "progress"):
                refused = bad_hash or wrong_version or changed or special_mode or attributes or changed_metadata
                if refused:
                    with self.assertRaises(RuntimeError):
                        remote.install_native_recipe(driver, item, run, remote.progress, remote.atomic_content, remote.locked_directory)
                else:
                    self.assertEqual(remote.install_native_recipe(driver, item, run, remote.progress, remote.atomic_content, remote.locked_directory), item["available"])
            self.assertEqual((directory / "AdGuardHome.yaml").read_text(), "private fixture configuration")
            self.assertFalse(list(directory.glob(".homelab-*")))
            self.assertEqual({entry.name for entry in directory.iterdir()}, {"AdGuardHome", "AdGuardHome.yaml"})
            restarts = [args for args in calls if "restart" in args]
            self.assertEqual(len(restarts), int(active and not refused))
            self.assertEqual(["/fixture/health"] in calls, active and not refused)
            if refused and not changed:
                self.assertEqual(binary.read_bytes(), b"old")
            if special_mode:
                self.assertEqual(binary.stat().st_mode & 0o7777, 0o4755)
            if attributes:
                self.assertEqual(os.getxattr(binary, "user.homelab-test"), b"preserve me")

    def test_adguard_updates_only_binary_with_hash_version_and_health_verification(self):
        self.adguard_fixture()

    def test_adguard_preserves_a_stopped_service(self):
        self.adguard_fixture(active=False)

    def test_adguard_bad_archive_cannot_replace_installed_binary(self):
        self.adguard_fixture(bad_hash=True)

    def test_adguard_wrong_archive_version_cannot_install(self):
        self.adguard_fixture(wrong_version=True)

    def test_adguard_concurrent_edits_are_preserved(self):
        self.adguard_fixture(changed=True)

    def test_adguard_refuses_special_executable_modes_before_replacement(self):
        self.adguard_fixture(special_mode=True)

    def test_adguard_refuses_extended_metadata_before_replacement(self):
        self.adguard_fixture(attributes=True)

    def test_adguard_rechecks_metadata_after_downloading(self):
        self.adguard_fixture(changed_metadata=True)

    def test_openclaw_uses_exact_tag_and_preserves_service_state(self):
        for active in (False, True):
            with self.subTest(active=active):
                calls = []
                def run(args, **_options):
                    calls.append(args)
                    if "--property=ActiveState" in args:
                        return "active" if active else "inactive"
                    if args[-1] == "--version":
                        return "2026.9.2" if any("update" in call for call in calls) else "2026.9.1"
                    return ""
                recipe = {"application": "openclaw", "command": ["/fixture/openclaw"], "service": "openclaw.service"}
                with patch.object(remote, "progress"):
                    self.assertEqual(remote.openclaw_install(recipe, "2026.9.1", "2026.9.2", run, remote.progress), active)
                self.assertIn(["/fixture/openclaw", "update", "--tag", "2026.9.2", "--yes", "--no-restart"], calls)
                self.assertEqual(sum("restart" in call for call in calls), int(active))

    def nextcloud_fixture(self, *, offered="33.0.1.1", wrong_url=False, modified=False, pending=False, failed_database=False, missing_option=None, required_values=False, extra_help=""):
        with tempfile.TemporaryDirectory(prefix="homelab-nextcloud-fixture-") as temporary:
            directory = Path(temporary).resolve()
            (directory / "updater").mkdir()
            (directory / "updater/updater.phar").write_bytes(b"fixture")
            (directory / "version.php").write_text("<?php $OC_Version = array(33,0,0,1); $OC_Build = 'fixture';")
            if pending:
                (directory / "updater-fixture").mkdir()
                (directory / "updater-fixture/.step").write_text('{}')
            calls = []
            def run(args, **_options):
                calls.append(args)
                if "--help" in args:
                    # Match Symfony's real updater help, including optional values
                    # and the short alias for noninteractive operation.
                    options = {
                        "url": "--url=URL" if required_values else "--url[=URL]",
                        "signature": "--signature=SIGNATURE" if required_values else "--signature[=SIGNATURE]",
                        "no-backup": "--no-backup",
                        "no-interaction": "-n, --no-interaction",
                    }
                    return "\n".join("  " + declaration + "  Description" for option, declaration in options.items() if option != missing_option) + "\n" + extra_help
                applied = any("--no-interaction" in call for call in calls)
                if "status" in args:
                    return json.dumps({"installed": True, "maintenance": False, "needsDbUpgrade": applied and failed_database, "versionstring": "33.0.1" if applied else "33.0.0"})
                if "integrity:check-core" in args:
                    return json.dumps({"INVALID_HASH": {"core": "changed"}} if modified else [])
                if "config:system:get" in args:
                    return "fixture" if args[-1] == "instanceid" else str(directory)
                if "-r" in args:
                    return "8x4x1"
                return ""
            url = "https://evil.invalid/nextcloud-33.0.1.zip" if wrong_url else "https://download.nextcloud.com/server/releases/nextcloud-33.0.1.zip"
            metadata = f"<nextcloud><version>{offered}</version><autoupdater>1</autoupdater><url>{url}</url><signature>{'a' * 344}</signature></nextcloud>".encode()
            recipe = {"application": "nextcloud", "directory": str(directory), "php": "/usr/bin/php", "user": "www-data"}
            with patch.object(remote, "native_download", return_value=metadata), patch.object(remote, "progress"):
                if offered != "33.0.1.1" or wrong_url or modified or pending or failed_database or missing_option:
                    with self.assertRaises(RuntimeError):
                        remote.nextcloud_install(recipe, "33.0.0", "33.0.1", run, remote.progress, remote.locked_directory)
                else:
                    self.assertTrue(remote.nextcloud_install(recipe, "33.0.0", "33.0.1", run, remote.progress, remote.locked_directory))
            installs = [call for call in calls if "--no-interaction" in call]
            self.assertEqual(len(installs), int(not (offered != "33.0.1.1" or wrong_url or modified or pending or missing_option)))
            if installs:
                self.assertIn("--no-backup", installs[0])
                self.assertNotIn("--no-verify", installs[0])
                self.assertNotIn("--ignore-state", installs[0])
                self.assertIn("--url=https://download.nextcloud.com/server/releases/nextcloud-33.0.1.zip", installs[0])
                self.assertIn("--signature=" + "a" * 344, installs[0])

    def test_nextcloud_uses_signed_exact_archive_and_checks_database_state(self):
        self.nextcloud_fixture()

    def test_nextcloud_accepts_required_value_help_notation(self):
        self.nextcloud_fixture(required_values=True)

    def test_nextcloud_option_lookalikes_and_prose_do_not_grant_capabilities(self):
        for option in ("url", "signature", "no-backup", "no-interaction"):
            for extra in (f"  --{option}-unsafe=VALUE  Description", f"  --not-{option}  Description", f"  --{option}[IGNORED]  Description", f"  This updater does not support --{option}"):
                with self.subTest(option=option, extra=extra):
                    self.nextcloud_fixture(missing_option=option, extra_help=extra)

    def test_nextcloud_refuses_changed_feed_candidate(self):
        self.nextcloud_fixture(offered="33.0.2.1")

    def test_nextcloud_refuses_nonvendor_download(self):
        self.nextcloud_fixture(wrong_url=True)

    def test_nextcloud_preserves_unreviewed_core_patches(self):
        self.nextcloud_fixture(modified=True)

    def test_nextcloud_will_not_resume_unknown_prior_update(self):
        self.nextcloud_fixture(pending=True)

    def test_nextcloud_incomplete_database_upgrade_is_not_success(self):
        self.nextcloud_fixture(failed_database=True)

    def test_nextcloud_legacy_updater_is_rejected_without_mutation(self):
        for option in ("url", "signature", "no-backup", "no-interaction"):
            with self.subTest(option=option):
                self.nextcloud_fixture(missing_option=option)

    def test_native_downgrades_and_provider_mismatch_never_invoke_a_command(self):
        driver = {"release": "openclaw", "recipe": {"application": "openclaw"}}
        for item in ({"installed": "1.1.0", "available": "1.0.0", "release": "openclaw"}, {"installed": "1.0.0", "available": "1.1.0", "release": "nextcloud"}):
            with patch.object(remote, "command") as run, self.assertRaises(RuntimeError):
                remote.install_native_recipe(driver, item, run, lambda _value: None, remote.atomic_content, remote.locked_directory)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
