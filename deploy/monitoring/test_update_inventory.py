"""Read-only collector regression fixtures. No daemon or package operation runs."""
import json
import types
import unittest
from unittest.mock import patch, mock_open, MagicMock

import update_inventory as inventory
from native_inventory import collect_native


class UpdateInventoryTests(unittest.TestCase):
    def test_native_failures_are_retained_and_do_not_hide_later_installations(self):
        sources = [{"provider": "adguard-home", "path": "/opt/AdGuardHome/AdGuardHome"}, {"provider": "node-exporter", "path": "/usr/local/bin/node_exporter"}]
        command = MagicMock(side_effect=[RuntimeError("private"), "node_exporter, version 1.10.0"])
        rows, complete = collect_native(sources, command)
        self.assertFalse(complete)
        self.assertEqual([row["installed"] for row in rows], ["Not reported", "1.10.0"])
        self.assertNotIn("private", json.dumps(rows))
        self.assertEqual(command.call_args_list[0].args[0], ["/opt/AdGuardHome/AdGuardHome", "--version"])

    def test_native_metadata_is_read_not_executed(self):
        with patch.object(inventory.Path, "stat", return_value=types.SimpleNamespace(st_size=100)), patch.object(inventory.Path, "read_text", return_value="Name: pgadmin4\nVersion: 9.8\n"):
            command = MagicMock()
            rows, complete = collect_native([{"provider": "pgadmin", "path": "/opt/venv/pgadmin4.dist-info/METADATA"}], command)
        self.assertTrue(complete)
        self.assertEqual(rows[0]["installed"], "9.8")
        command.assert_not_called()

    def test_digest_pin_is_not_a_package_hold(self):
        identifier = "a" * 64
        responses = [identifier, '"/demo-web","example/web@sha256:' + "c" * 64 + '","sha256:' + "b" * 64 + '"', '"linux","amd64",""']
        with patch.object(inventory, "command", side_effect=responses):
            rows = inventory.docker_inventory(["demo"], {"demo-web": "stable"})
        self.assertTrue(rows[0]["pinned"])
        self.assertFalse(rows[0]["held"])
        self.assertEqual(rows[0]["imageTag"], "stable")

    def test_runtime_versions_use_fixed_arguments_and_no_identity_state(self):
        with patch.object(inventory, "command", return_value="bun 1.4.2\n") as command:
            report = inventory.collect({"apt": False, "executables": {"bun": "/usr/local/bin/bun"}})
        command.assert_called_once_with(["/usr/local/bin/bun", "--version"])
        self.assertEqual(report["items"][0]["installed"], "1.4.2")
        self.assertEqual(report["items"][0]["status"], "unknown")
        self.assertEqual(report["coveredKinds"], ["runtime"])

    def test_failed_source_is_incomplete_not_false_current(self):
        with patch.object(inventory, "apt_inventory", side_effect=RuntimeError("private error")), patch.object(inventory, "runtime_inventory", return_value=[]):
            report = inventory.collect({"apt": True})
        self.assertFalse(report["complete"])
        self.assertEqual(report["items"], [])
        self.assertNotIn("private", json.dumps(report))

    def test_apt_uses_debian_candidate_order_and_retains_holds(self):
        package = types.SimpleNamespace(is_installed=True, fullname="example:amd64", installed=types.SimpleNamespace(version="1:2.0-1"), candidate=types.SimpleNamespace(version="2:1.0-1", origins=[types.SimpleNamespace(archive="stable-security")]), is_upgradable=True, _pkg=types.SimpleNamespace(selected_state=2))
        modules = {"apt": types.SimpleNamespace(Cache=lambda: [package]), "apt_pkg": types.SimpleNamespace(version_compare=lambda left, right: 1, SELSTATE_HOLD=2)}
        with patch.dict("sys.modules", modules), patch.object(inventory.Path, "glob", return_value=[]), patch.object(inventory.Path, "is_file", return_value=False):
            rows, metadata = inventory.apt_inventory()
        self.assertEqual(rows[0]["status"], "available")
        self.assertTrue(rows[0]["held"])
        self.assertTrue(rows[0]["security"])
        self.assertIsNone(metadata)

    def test_docker_reads_only_scoped_metadata_and_never_controls_or_pulls(self):
        identifier = "a" * 64
        responses = [identifier, '"/demo-web","example/web:latest","sha256:' + "b" * 64 + '"', '"linux","amd64",""']
        with patch.object(inventory, "command", side_effect=responses) as command:
            rows = inventory.docker_inventory(["demo"])
        calls = [item.args[0] for item in command.call_args_list]
        self.assertIn("label=com.docker.compose.project=demo", calls[0])
        self.assertTrue(all("pull" not in call and "start" not in call and "stop" not in call for call in calls))
        self.assertEqual(rows[0]["platform"], {"os": "linux", "architecture": "amd64"})
        self.assertNotIn("Env", str(calls))

    def test_invalid_programs_projects_and_unconfigured_sources_fail_closed(self):
        with self.assertRaises(ValueError):
            inventory.runtime_inventory({"executables": {"shell": "/bin/sh"}})
        with self.assertRaises(ValueError):
            inventory.runtime_inventory({"executables": {"bun": "bun"}})
        with self.assertRaises(ValueError):
            inventory.docker_inventory(["--privileged"])
        with self.assertRaises(ValueError):
            inventory.collect({"apt": False})

    def test_publisher_refuses_redirecting_a_bearer_credential(self):
        redirect = inventory.NoRedirect()
        self.assertIsNone(redirect.redirect_request(None, None, 302, "Found", {}, "https://other.example.test"))

    def test_publisher_requires_explicit_accepted_receipt(self):
        envelopes = [
            {"result": {"data": {"json": {"accepted": True}}}},
            {"result": {"data": {"json": {"accepted": False}}}},
            {"result": {"data": {"json": {"accepted": "true"}}}},
            {"result": {"data": {"json": {}}}},
            {"result": {}},
            {"result": []},
            {"error": {"message": "private upstream failure"}},
            [],
        ]
        for index, payload in enumerate(envelopes):
            with self.subTest(payload=payload):
                response = MagicMock()
                response.__enter__.return_value.read.return_value = json.dumps(payload).encode()
                opener = MagicMock()
                opener.open.return_value = response
                with patch("builtins.open", mock_open(read_data="{}")), patch.object(inventory, "collect", return_value={"capturedAt": "synthetic"}), patch.dict(inventory.os.environ, {"HOMELAB_DASHBOARD_ORIGIN": "https://dashboard.example.test", "HOMELAB_DASHBOARD_UPDATE_TOKEN": "synthetic"}), patch("sys.argv", ["update_inventory.py", "--config", "/synthetic.json"]), patch.object(inventory.urllib.request, "build_opener", return_value=opener), patch("builtins.print") as output:
                    if index == 0:
                        inventory.main()
                        output.assert_called_once_with("Update inventory delivered.")
                    else:
                        with self.assertRaisesRegex(RuntimeError, "Inventory delivery failed"):
                            inventory.main()
                        output.assert_not_called()


if __name__ == "__main__":
    unittest.main()
