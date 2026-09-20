"""Exercise updater safety against synthetic files and replaced commands, never a live daemon."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "apps/dashboard/src/server/integrations/updates/remote.py"
SPEC = importlib.util.spec_from_file_location("update_execution_fixture", SOURCE)
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)


class UpdateExecutionTests(unittest.TestCase):
    """Cover exact image pins, source fencing, package boundaries and private error handling."""

    def docker_fixture(self, mode="running", mutate=False, fail=False):
        with tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
            directory = Path(temporary).resolve()
            source = directory / "compose.yaml"
            old = "example/web:1.2.3@sha256:" + "a" * 64
            new = "docker.io/example/web:1.3.0@sha256:" + "b" * 64
            original = ("services:\n  web:\n    image: " + old + "\n    environment:\n      PRIVATE: synthetic-private-value\n").encode()
            source.write_bytes(original)
            driver = {"kind": "docker", "name": "demo-web-1", "project": "demo", "service": "web", "directory": str(directory), "file": str(source), "imageFile": str(source)}
            item = {"id": "docker:" + "c" * 64, "image": old, "installed": "sha256:" + "d" * 64, "available": "sha256:" + "e" * 64, "availableImage": new}
            calls = []
            installed = False

            def command(arguments, timeout=120):
                nonlocal installed
                calls.append(arguments)
                if arguments[1] == "inspect":
                    values = ["/demo-web-1", new if installed else old, item["available"] if installed else item["installed"], "created" if installed and mode != "running" else mode, "demo", "web"]
                    return ",".join(json.dumps(value) for value in values)
                if arguments[1:3] == ["image", "inspect"]:
                    return item["available"]
                if arguments[1] == "pull":
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
                if mutate or fail:
                    with self.assertRaises(RuntimeError):
                        remote.docker_update(driver, item, True)
                else:
                    self.assertEqual(remote.docker_update(driver, item, True), item["available"])
            contents = source.read_bytes()
            self.assertIn(b"synthetic-private-value", contents)
            self.assertFalse(list(directory.glob(".homelab-update-*")))
            if mutate:
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

    def test_stopped_image_update_does_not_start_the_service(self):
        self.docker_fixture(mode="exited")

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

    def test_failure_receipt_omits_updater_output_and_private_data(self):
        payload = {"driver": {"kind": "native", "inspect": [sys.executable, "-c", "raise Exception('synthetic-private-value')"]}, "item": {"installed": "1.0.0"}, "automatic": False}
        result = subprocess.run([sys.executable, str(SOURCE)], input=json.dumps(payload), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("synthetic-private-value", result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1]), {"complete": False})


if __name__ == "__main__":
    unittest.main()
