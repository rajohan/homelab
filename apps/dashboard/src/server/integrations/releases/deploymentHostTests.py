"""Host-journal failure tests using private temporary files and synthetic subprocesses."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location("host", Path(__file__).with_name("deploymentHost.py"))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.compose = self.root / "compose.yaml"
        self.old = "ghcr.io/demo/homelab/dashboard:1.2.2@sha256:" + "a" * 64
        self.new = "ghcr.io/demo/homelab/dashboard:1.2.3@sha256:" + "b" * 64
        self.source = ("services:\n  dashboard:\n    image: '" + self.old + "'\n").encode()
        self.compose.write_bytes(self.source)
        self.compose.chmod(0o600)
        self.target = {"directory": str(self.root), "stateDirectory": str(self.state), "composeFile": str(self.compose),
                       "project": "homelab", "composeCommand": ["/fixture/compose"], "backupCommand": ["/fixture/backup"],
                       "migrateCommand": ["/fixture/migrate", "{image}"], "services": [{"name": "dashboard", "app": "dashboard"}],
                       "units": ["fixture.service"]}
        self.release = {"repository": "demo/homelab", "version": "1.2.3", "revision": "c" * 40,
                        "images": [{"app": "dashboard", "reference": self.new}]}
        self.identity = str(uuid.uuid4())
        self.operation = self.state / self.identity
        self.operation.mkdir(mode=0o700)
        self.alter_config = False
        self.expected = {"composeHash": host.digest(self.source), "configHash": host.digest(host.encoded(self.config())),
                         "containers": {"dashboard": {"image": self.old, "imageId": "sha256:" + "a" * 64}}}
        self.intent = {"id": self.identity, "target": self.target, "release": self.release, "expected": self.expected}
        host.replace_file(self.operation / "intent.json", host.encoded(self.intent))
        host.save_status(self.operation, {"id": self.identity, "requestHash": host.digest(host.encoded(self.intent)),
                                         "phase": "accepted", "state": "running", "changesStarted": False, "migrationStarted": False})
        self.calls = []
        self.failure = None
        self.alter_config = False

    def tearDown(self):
        self.temporary.cleanup()

    def config(self, _target=None):
        value = {"name": "homelab", "services": {"dashboard": {"image": self.new if self.new in self.compose.read_text() else self.old,
                                                               "environment": {"UNCHANGED": "yes"}}}}
        if self.alter_config and self.new in self.compose.read_text():
            value["services"]["dashboard"]["environment"]["UNCHANGED"] = "changed"
        return value

    def command(self, arguments, _directory, timeout=60, output_file=None):
        self.calls.append(arguments)
        if arguments[0] == "/fixture/backup":
            output_file.write(b"PGDMPsynthetic")
        if self.failure and self.failure in arguments:
            raise host.Refusal("command_failed")
        return b""

    def perform(self):
        with patch.object(host, "inspect", return_value=self.expected), patch.object(host, "configured", side_effect=self.config), \
                patch.object(host, "command", side_effect=self.command), patch.object(host, "image_identity", return_value="sha256:" + "b" * 64), \
                patch.object(host, "container", return_value={"running": False}), patch.object(host, "verify_services", return_value={"dashboard": {"healthy": True}}):
            host.run(self.operation)
        return json.loads((self.operation / "status.json").read_text())

    def test_success_and_replay(self):
        self.alter_config = False
        result = self.perform()
        self.assertEqual(result["state"], "succeeded")
        self.assertTrue(result["migrationStarted"])
        self.assertEqual((self.operation / "compose.before").read_bytes(), self.source)
        self.assertEqual((self.operation / "database.dump").stat().st_mode & 0o777, 0o600)
        self.assertIn(self.new, self.compose.read_text())
        calls = len(self.calls)
        with self.assertRaisesRegex(host.Refusal, "operation_replay"):
            self.perform()
        self.assertEqual(len(self.calls), calls)

    def test_failed_backup_recovers_before_migration(self):
        self.failure = "/fixture/backup"
        result = self.perform()
        self.assertEqual(result["state"], "failed")
        self.assertTrue(result["recovered"])
        self.assertFalse(result["migrationStarted"])
        self.assertEqual(self.compose.read_bytes(), self.source)
        self.assertFalse(any(arguments[0] == "/fixture/migrate" for arguments in self.calls))

    def test_non_image_configuration_change_restores_original_before_migration(self):
        self.alter_config = True
        result = self.perform()
        self.assertEqual(result["code"], "configuration_changed")
        self.assertTrue(result["recovered"])
        self.assertFalse(result["migrationStarted"])
        self.assertEqual(self.compose.read_bytes(), self.source)

    def test_migration_failure_never_rolls_back_images_or_resumes_work(self):
        self.failure = "/fixture/migrate"
        result = self.perform()
        self.assertTrue(result["migrationStarted"])
        self.assertFalse(result["recovered"])
        self.assertIn(self.new, self.compose.read_text())
        self.assertFalse(any("start" in arguments for arguments in self.calls))

    def test_recovery_requires_database_attestation_and_original_configuration(self):
        self.failure = "/fixture/migrate"
        self.perform()
        with patch.object(host,"unit_state",return_value={"active":"inactive"}), \
                patch.object(host,"configured",side_effect=self.config), patch.object(host,"verify_services",return_value={}):
            with self.assertRaisesRegex(host.Refusal,"database_recovery_required"):
                host.recover(self.operation)
            with self.assertRaisesRegex(host.Refusal,"configuration_changed"):
                host.recover(self.operation, True)
            self.compose.write_bytes(self.source)
            host.recover(self.operation, True)
        result=json.loads((self.operation/"status.json").read_text())
        self.assertTrue(result["recovered"])
        self.assertEqual(result["code"],"operator_recovered")

    def test_dead_runner_returns_unknown_without_replay(self):
        with patch.object(host,"unit_state",return_value={"active":"inactive"}):
            self.assertEqual(host.status(self.target,self.identity)["state"],"unknown")
        self.assertEqual(json.loads((self.operation/"status.json").read_text())["phase"],"accepted")

    def test_changed_source_and_links_are_refused(self):
        with self.assertRaisesRegex(host.Refusal,"configuration_changed"):
            host.replace_file(self.compose,b"bad",b"changed")
        link=self.root/"link"
        link.symlink_to(self.compose)
        with self.assertRaises(host.Refusal):host.read_file(link)
        self.compose.chmod(0o666)
        with self.assertRaisesRegex(host.Refusal,"path_permissions"):host.read_file(self.compose)

    def test_only_literal_image_fields_can_change(self):
        for source in [b"services:\n  dashboard:\n    image: ${IMAGE}\n",self.source+self.source]:
            with self.assertRaisesRegex(host.Refusal,"configuration_ambiguous"):
                host.compose_replacement(source,self.config(),self.target,{"dashboard":self.new})
        replacement,expected=host.compose_replacement(self.source,self.config(),self.target,{"dashboard":self.new})
        self.assertEqual(replacement,self.source.replace(self.old.encode(),self.new.encode()))
        self.assertEqual(expected["services"]["dashboard"]["environment"],{"UNCHANGED":"yes"})

    def test_submission_is_idempotent_and_refuses_changed_intent(self):
        request={"mode":"submit",**self.intent,"deadline":time.time()+30}
        with patch.object(host,"unit_state",return_value={"active":"active"}), patch.object(host,"command",side_effect=AssertionError("no launch")):
            self.assertEqual(host.submit(request,"source")["phase"],"accepted")
            changed=copy.deepcopy(request)
            changed["release"]["version"]="1.2.4"
            with self.assertRaisesRegex(host.Refusal,"operation_changed"):host.submit(changed,"source")

    def test_image_labels_and_platform_must_match_release(self):
        valid={"Architecture":"amd64","Os":"linux","Id":"sha256:"+"b"*64,"Config":{"Labels":{
            "org.opencontainers.image.source":"https://github.com/demo/homelab",
            "org.opencontainers.image.version":"1.2.3","org.opencontainers.image.revision":"c"*40}}}
        with patch.object(host,"command",return_value=json.dumps([valid]).encode()):
            self.assertEqual(host.image_identity(self.target,self.new,self.release),valid["Id"])
        for field,value in [("Architecture","arm64"),("Os","windows"),("Id","invalid"),("Config",{})]:
            changed={**valid,field:value}
            with patch.object(host,"command",return_value=json.dumps([changed]).encode()),self.assertRaisesRegex(host.Refusal,"image_verification"):
                host.image_identity(self.target,self.new,self.release)

    def test_directory_lock_excludes_other_operations(self):
        with host.directory_lock(self.root),self.assertRaisesRegex(host.Refusal,"host_busy"):
            with host.directory_lock(self.root):pass

    def test_backup_url_uses_explicit_libpq_fields_and_rejects_connection_overrides(self):
        environment=host.database_environment('postgres://demo:p%40ss@[::1]:5433/test%20db?sslmode=require&connect_timeout=8')
        self.assertEqual(environment['PGHOST'],'::1')
        self.assertEqual(environment['PGPASSWORD'],'p@ss')
        self.assertEqual(environment['PGDATABASE'],'test db')
        self.assertEqual(environment['PGPORT'],'5433')
        self.assertEqual(environment['PGSSLMODE'],'require')
        for value in ['postgres:///db','postgres://demo@host/','postgres://demo@host/db?host=other',
                      'postgres://demo@host/db?sslmode=require&sslmode=disable','postgres://demo@host/db?connect_timeout=0',
                      'postgres://demo:p%00ss@host/db']:
            with self.assertRaises(host.Refusal):host.database_environment(value)


if __name__=="__main__":
    unittest.main()
