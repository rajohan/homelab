"""Exercise updater safety against synthetic files and replaced commands, never a live daemon."""
import copy
import importlib.util
import hashlib
import io
import json
from pathlib import Path
import subprocess
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
exec(compile(SOURCE.with_name("native.py").read_text(), str(SOURCE.with_name("native.py")), "exec"), remote.__dict__)


class UpdateExecutionTests(unittest.TestCase):
    """Cover exact image pins, source fencing, package boundaries and private error handling."""

    def docker_fixture(self, mode="running", mutate=False, fail=False, with_environment=False, manifest_store=False, wrong_pull=False):
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

            def command(arguments, timeout=120, environment=None, output_limit=2_000_000):
                nonlocal installed
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
                    values = ["/demo-web-1", new if installed else old, item["available"] if installed else item["installed"], "created" if installed and mode != "running" else mode, "demo", "web"]
                    return ",".join(json.dumps(value) for value in values)
                if arguments[1:3] == ["image", "inspect"]:
                    return "sha256:" + "f" * 64 if wrong_pull else item["available"]
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
                if mutate or fail or wrong_pull:
                    with self.assertRaises(RuntimeError):
                        remote.docker_update(driver, item, True)
                else:
                    self.assertEqual(remote.docker_update(driver, item, True), item["available"])
            contents = source.read_bytes()
            if with_environment:
                self.assertEqual(sum(call[0] == "/fixture/environment" for call in calls), 1)
            self.assertIn(b"synthetic-private-value", contents)
            self.assertFalse(list(directory.glob(".homelab-update-*")))
            if wrong_pull:
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

    def adguard_fixture(self, *, bad_hash=False, wrong_version=False, active=True, changed=False):
        with tempfile.TemporaryDirectory(prefix="homelab-native-fixture-") as temporary:
            directory = Path(temporary).resolve()
            binary = directory / "AdGuardHome"
            binary.write_bytes(b"old")
            binary.chmod(0o755)
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
                return content
            with patch.object(remote, "native_download", side_effect=download), patch.object(remote, "progress"):
                if bad_hash or wrong_version or changed:
                    with self.assertRaises(RuntimeError):
                        remote.install_native_recipe(driver, item, run, remote.progress, remote.atomic_content, remote.locked_directory)
                else:
                    self.assertEqual(remote.install_native_recipe(driver, item, run, remote.progress, remote.atomic_content, remote.locked_directory), item["available"])
            self.assertEqual((directory / "AdGuardHome.yaml").read_text(), "private fixture configuration")
            self.assertFalse(list(directory.glob(".homelab-*")))
            self.assertEqual({entry.name for entry in directory.iterdir()}, {"AdGuardHome", "AdGuardHome.yaml"})
            restarts = [args for args in calls if "restart" in args]
            self.assertEqual(len(restarts), int(active and not (bad_hash or wrong_version or changed)))
            self.assertEqual(["/fixture/health"] in calls, active and not (bad_hash or wrong_version or changed))
            if bad_hash or wrong_version:
                self.assertEqual(binary.read_bytes(), b"old")

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

    def nextcloud_fixture(self, *, offered="33.0.1.1", wrong_url=False, modified=False, pending=False, failed_database=False):
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
                applied = any(any(value.endswith("updater.phar") for value in call) for call in calls)
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
                if offered != "33.0.1.1" or wrong_url or modified or pending or failed_database:
                    with self.assertRaises(RuntimeError):
                        remote.nextcloud_install(recipe, "33.0.0", "33.0.1", run, remote.progress, remote.locked_directory)
                else:
                    self.assertTrue(remote.nextcloud_install(recipe, "33.0.0", "33.0.1", run, remote.progress, remote.locked_directory))
            installs = [call for call in calls if any(value.endswith("updater.phar") for value in call)]
            self.assertEqual(len(installs), int(not (offered != "33.0.1.1" or wrong_url or modified or pending)))
            if installs:
                self.assertIn("--no-backup", installs[0])
                self.assertNotIn("--no-verify", installs[0])
                self.assertNotIn("--ignore-state", installs[0])
                self.assertIn("--url=https://download.nextcloud.com/server/releases/nextcloud-33.0.1.zip", installs[0])

    def test_nextcloud_uses_signed_exact_archive_and_checks_database_state(self):
        self.nextcloud_fixture()

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

    def test_native_downgrades_and_provider_mismatch_never_invoke_a_command(self):
        driver = {"release": "openclaw", "recipe": {"application": "openclaw"}}
        for item in ({"installed": "1.1.0", "available": "1.0.0", "release": "openclaw"}, {"installed": "1.0.0", "available": "1.1.0", "release": "nextcloud"}):
            with patch.object(remote, "command") as run, self.assertRaises(RuntimeError):
                remote.install_native_recipe(driver, item, run, lambda _value: None, remote.atomic_content, remote.locked_directory)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
