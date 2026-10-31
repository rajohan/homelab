"""Host-journal failure tests using private temporary files and synthetic subprocesses."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import subprocess
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

    def test_failed_backup_cannot_resume_with_unverified_browser_recovery(self):
        self.failure = "/fixture/backup"
        with patch.object(host, "verify_browser_recovery", side_effect=host.Refusal("configuration_changed")):
            result = self.perform()
        self.assertEqual(result["state"], "failed")
        self.assertFalse(result["migrationStarted"])
        self.assertFalse(result["recovered"])

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

    def test_schema_label_is_verified_against_the_published_candidate(self):
        release={**self.release,"dashboardSchema":"d"*64}
        image={"Architecture":"amd64","Os":"linux","Id":"sha256:"+"b"*64,"Config":{"Labels":{
            "org.opencontainers.image.source":"https://github.com/demo/homelab",
            "org.opencontainers.image.version":"1.2.3","org.opencontainers.image.revision":"c"*40,
            "io.homelab.dashboard-schema":"d"*64}}}
        with patch.object(host,"command",return_value=json.dumps([image]).encode()):
            self.assertEqual(host.image_identity(self.target,self.new,release),image["Id"])
        image["Config"]["Labels"]["io.homelab.dashboard-schema"]="e"*64
        with patch.object(host,"command",return_value=json.dumps([image]).encode()),self.assertRaisesRegex(host.Refusal,"image_verification"):
            host.image_identity(self.target,self.new,release)

    def test_installed_schema_comes_from_image_not_compose_labels(self):
        identity="a"*64
        container={"Id":identity,"Image":"sha256:"+identity,"Config":{"Image":self.old,"Labels":{
            "com.docker.compose.project":"homelab","com.docker.compose.service":"dashboard","io.homelab.dashboard-schema":"f"*64}},
            "State":{"Running":True,"Health":{"Status":"healthy"}}}
        for schema in ["d"*64,"malformed",None]:
            with patch.object(host,"command",side_effect=[identity.encode(),json.dumps([container]).encode(),json.dumps([{"Config":{"Labels":{"io.homelab.dashboard-schema":schema}}}]).encode()]):
                result=host.container(self.target,"dashboard")
            self.assertEqual(result["dashboardSchema"],schema if schema=="d"*64 else None)

    def test_auth_image_and_backup_are_bound_to_auth(self):
        reference = self.new.replace("/dashboard:", "/auth:")
        release = {**self.release, "authSchema": "d" * 64,
                   "images": [*self.release["images"], {"app": "auth", "reference": reference}]}
        image = {"Architecture": "amd64", "Os": "linux", "Id": "sha256:" + "b" * 64,
                 "Config": {"Labels": {"org.opencontainers.image.source": "https://github.com/demo/homelab",
                 "org.opencontainers.image.version": "1.2.3", "org.opencontainers.image.revision": "c" * 40,
                 "io.homelab.auth-schema": "d" * 64}}}
        with patch.object(host, "command", return_value=json.dumps([image]).encode()):
            self.assertEqual(host.image_identity(self.target, reference, release), image["Id"])
        image["Config"]["Labels"]["io.homelab.auth-schema"] = "e" * 64
        with patch.object(host, "command", return_value=json.dumps([image]).encode()), self.assertRaisesRegex(host.Refusal, "image_verification"):
            host.image_identity(self.target, reference, release)
        self.assertEqual(host.recipe(["/fixture/migrate", "{authImage}"], self.operation, host.release_images(release)), ["/fixture/migrate", reference])
        with patch.object(host.sys, "argv", ["runner.py", "backup", "auth"]), \
             patch.dict(host.os.environ, {"HOMELAB_AUTH_DATABASE_URL": "postgres://operator@db.example.test/auth", "HOMELAB_DASHBOARD_DATABASE_URL": "postgres://operator@db.example.test/dashboard"}, clear=True), \
             patch.object(host.os, "execve", side_effect=RuntimeError("intercepted")) as execute:
            with self.assertRaisesRegex(RuntimeError, "intercepted"): host.main()
            self.assertEqual(execute.call_args.args[2]["PGDATABASE"], "auth")
        with patch.object(host.sys, "argv", ["runner.py", "backup", "unexpected"]), self.assertRaisesRegex(host.Refusal, "backup_configuration"):
            host.main()

    def test_automatic_read_can_observe_current_version_but_submit_inspection_stays_strict(self):
        current={"image":self.old,"running":True,"health":"healthy"}
        release={**self.release,"version":"1.2.2","images":[{"app":"dashboard","reference":self.old}]}
        with patch.object(host,"canonical"),patch.object(host,"configured",side_effect=self.config),patch.object(host,"container",return_value=current),patch.object(host,"unit_state",return_value={"active":"active","invocation":"a"*32}):
            self.assertEqual(host.inspect(self.target,release,True)["containers"]["dashboard"],current)
            with self.assertRaisesRegex(host.Refusal,"release_not_newer"):host.inspect(self.target,release)

    def test_directory_lock_excludes_other_operations(self):
        with host.directory_lock(self.root),self.assertRaisesRegex(host.Refusal,"host_busy"):
            with host.directory_lock(self.root):pass

    def browser_fixture(self):
        browser = {"hostId": str(uuid.uuid4()), "socketPath": "/run/docker.sock", "imageId": "sha256:" + "d"*64,
                   "networks": [{"networkId": "e"*64, "proxyId": "f"*64, "proxyImageId": "sha256:" + "a"*64}]}
        target = {**self.target, "browserConfigFile": str(self.root / "browser.json"),
                  "browserProxyUnits": ["proxy.service"], "units": ["fixture.service", "proxy.service"],
                  "services": [*self.target["services"], {"name": "proxy", "app": "mira-browser-proxy"}]}
        observed = {"proxy": {"id": "f"*64, "imageId": "sha256:" + "a"*64}}
        return target, browser, observed

    def test_browser_slots_require_complete_unique_managed_proxy_mapping(self):
        target, browser, observed = self.browser_fixture()
        self.assertEqual(host.browser_bindings(target, browser, observed), [{"service": "proxy", "networkId": "e"*64}])
        cases = [({**target, "browserProxyUnits": []}, browser, observed),
                 ({**target, "browserProxyUnits": target["units"]}, browser, observed),
                 ({**target, "browserProxyUnits": ["unmanaged.service"]}, browser, observed),
                 (target, {**browser, "networks": []}, observed),
                 (target, {**browser, "networks": [*browser["networks"], *browser["networks"]]}, observed),
                 (target, browser, {"proxy": {"id": "1"*64, "imageId": "sha256:" + "a"*64}}),
                 (target, browser, {"proxy": {"id": "f"*64, "imageId": "sha256:" + "b"*64}})]
        for arguments in cases:
            with self.subTest(arguments=arguments), self.assertRaises(host.Refusal):
                host.browser_bindings(*arguments)
        self.assertEqual(host.browser_bindings(self.target, {"imageId": "sha256:" + "a"*64}, {}), [])

    def test_preparation_allows_active_browser_but_submission_requires_drained_network(self):
        target, browser, observed = self.browser_fixture()
        path = Path(target["browserConfigFile"])
        path.write_bytes(host.encoded(browser))
        path.chmod(0o600)
        proxy_image = "ghcr.io/demo/homelab/mira-browser-proxy:1.2.2@sha256:" + "a"*64
        observed["proxy"].update(image=proxy_image, running=True, health="healthy")
        observed["dashboard"] = {"image": self.old, "running": True, "health": "healthy"}
        release = {**self.release, "images": [*self.release["images"],
            {"app": "mira-browser-proxy", "reference": "ghcr.io/demo/homelab/mira-browser-proxy:1.2.3@sha256:" + "b"*64},
            {"app": "mira-browser", "reference": "ghcr.io/demo/homelab/mira-browser:1.2.3@sha256:" + "b"*64}]}
        config = {"name": "homelab", "services": {name: {"image": value["image"]} for name, value in observed.items()}}
        with patch.object(host, "configured", return_value=config), patch.object(host, "container", side_effect=lambda _target, name: observed[name]), \
                patch.object(host, "unit_state", return_value={"active": "active", "invocation": "a"*32}), \
                patch.object(host, "browser_slots", side_effect=host.Refusal("browser_proxy_verification")) as guard:
            expected = host.inspect(target, release)
            guard.assert_not_called()
            with self.assertRaisesRegex(host.Refusal, "browser_proxy_verification"):
                host.inspect(target, release, drained=True)
            identity = str(uuid.uuid4())
            with self.assertRaisesRegex(host.Refusal, "browser_proxy_verification"):
                host.submit({"target": target, "id": identity, "release": release, "expected": expected, "deadline": time.time()+30}, "unused")
            self.assertFalse((self.state / identity).exists())

    def test_browser_slots_reject_network_replacement_extra_peers_and_wrong_image(self):
        target, browser, observed = self.browser_fixture()
        bindings = host.browser_bindings(target, browser, observed)
        network = {"Id": "e"*64, "Driver": "bridge", "Internal": True, "EnableIPv6": False,
                   "Options": {"com.docker.network.bridge.gateway_mode_ipv4": "isolated"}, "Containers": {"f"*64: {}}}
        proxy = {"Id": "f"*64, "Image": "sha256:" + "a"*64, "State": {"Running": True, "Health": {"Status": "healthy"}},
                 "NetworkSettings": {"Networks": {"slot": {"NetworkID": "e"*64, "Aliases": ["mira-egress"],
                     "DriverOpts": {"com.docker.network.endpoint.ifname": "browser"}}, "outbound": {"NetworkID": "1"*64}}}}
        with patch.object(host, "command", side_effect=[host.encoded([network]), host.encoded([proxy])]):
            self.assertEqual(host.browser_slots(target, bindings, observed), browser["networks"])
        cases = [({**network, "Id": "1"*64}, proxy), ({**network, "Internal": False}, proxy),
                 ({**network, "Containers": {"f"*64: {}, "1"*64: {}}}, proxy),
                 (network, {**proxy, "Image": "sha256:" + "b"*64}),
                 (network, {**proxy, "State": {"Running": True, "Health": {"Status": "starting"}}}),
                 (network, {**proxy, "NetworkSettings": {"Networks": {}}})]
        for changed_network, changed_proxy in cases:
            with self.subTest(network=changed_network, proxy=changed_proxy), patch.object(host, "command", side_effect=[host.encoded([changed_network]), host.encoded([changed_proxy])]), self.assertRaisesRegex(host.Refusal, "browser_proxy_verification"):
                host.browser_slots(target, bindings, observed)

    def test_browser_recovery_accepts_only_verified_proxy_id_refresh(self):
        target, browser, observed = self.browser_fixture()
        source = host.encoded(browser)
        before = {"browserHash": host.digest(source), "containers": observed}
        (self.operation / "browser.before").write_bytes(source)
        (self.operation / "browser.before").chmod(0o600)
        path = Path(target["browserConfigFile"])
        restored = {**browser, "networks": [{**browser["networks"][0], "proxyId": "1"*64}]}
        path.write_bytes(host.encoded(restored))
        path.chmod(0o600)
        with patch.object(host, "browser_slots", return_value=restored["networks"]):
            host.verify_browser_recovery(target, self.operation, before, observed)
            for changed in [browser, {**restored, "imageId": "sha256:" + "b"*64},
                            {**restored, "hostId": str(uuid.uuid4())}, {**restored, "socketPath": "/other.sock"},
                            {**restored, "networks": [{**restored["networks"][0], "networkId": "2"*64}]}]:
                path.write_bytes(host.encoded(changed))
                with self.assertRaisesRegex(host.Refusal, "configuration_changed"):
                    host.verify_browser_recovery(target, self.operation, before, observed)
            (self.operation / "browser.before").write_bytes(host.encoded(restored))
            with self.assertRaisesRegex(host.Refusal, "configuration_changed"):
                host.verify_browser_recovery(target, self.operation, before, observed)

    def test_browser_proxy_ids_refresh_before_other_units_start_and_failure_holds_deployment(self):
        baseline = copy.deepcopy(self.target)
        for failure in [None, "network", "early_start", "recreated", "config_race",
                        "backup_recreate", "backup_network", "backup_config_race", "stop_partial", "stop_persistent"]:
            with self.subTest(failure=failure):
                backup_failure = bool(failure and failure.startswith("backup_"))
                stop_failure = bool(failure and failure.startswith("stop_"))
                recovery = backup_failure or stop_failure
                self.target = copy.deepcopy(baseline)
                self.target, browser, observed = self.browser_fixture()
                old_proxy = "ghcr.io/demo/homelab/mira-browser-proxy:1.2.2@sha256:" + "a"*64
                new_proxy = "ghcr.io/demo/homelab/mira-browser-proxy:1.2.3@sha256:" + "b"*64
                self.source = ("services:\n  dashboard:\n    image: " + self.old + "\n  proxy:\n    image: " + old_proxy + "\n").encode()
                self.compose.write_bytes(self.source)
                browser_path = Path(self.target["browserConfigFile"])
                browser_path.write_bytes(host.encoded(browser))
                browser_path.chmod(0o600)
                self.release["images"] = [{"app": "dashboard", "reference": self.new}, {"app": "mira-browser-proxy", "reference": new_proxy},
                                          {"app": "mira-browser", "reference": "ghcr.io/demo/homelab/mira-browser:1.2.3@sha256:" + "b"*64}]
                self.expected["containers"] = {"dashboard": {"image": self.old, "imageId": "sha256:" + "a"*64},
                                               "proxy": {**observed["proxy"], "image": old_proxy}}
                self.expected["browserHash"] = host.digest(host.encoded(browser))
                self.intent.update(target=self.target, release=self.release, expected=self.expected)
                host.replace_file(self.operation / "intent.json", host.encoded(self.intent), (self.operation / "intent.json").read_bytes())
                host.save_status(self.operation, {"id": self.identity, "requestHash": host.digest(host.encoded(self.intent)),
                     "phase": "accepted", "state": "running", "changesStarted": False, "migrationStarted": False})
                self.calls = []
                started = []
                stopped = []
                slots = [{"networkId": "e"*64, "proxyId": "2"*64,
                          "proxyImageId": "sha256:" + ("a" if recovery else "b")*64}]

                def configured(_target):
                    text = self.compose.read_text()
                    return {"name": "homelab", "services": {"dashboard": {"image": self.new if self.new in text else self.old},
                            "proxy": {"image": new_proxy if new_proxy in text else old_proxy}}}

                def execute(arguments, directory, timeout=60, output_file=None):
                    if arguments[:2] == ["/usr/bin/systemctl", "stop"]:
                        stopped.append(arguments[2:])
                        self.assertEqual(arguments[2:], self.target["units"])
                        if stop_failure and len(stopped) == 1:
                            raise host.Refusal("command_failed")
                    if backup_failure and arguments[0] == "/fixture/backup":
                        raise host.Refusal("command_failed")
                    if arguments[:2] == ["/usr/bin/systemctl", "start"]:
                        started.append(arguments[2:])
                        if len(started) == 1:
                            self.assertEqual(arguments[2:], ["proxy.service"])
                        else:
                            saved = json.loads(browser_path.read_bytes())
                            self.assertEqual(saved["networks"], slots)
                            self.assertEqual(saved["imageId"], browser["imageId"] if recovery else "sha256:" + "b"*64)
                            self.assertEqual(saved["hostId"], browser["hostId"])
                    return self.command(arguments, directory, timeout, output_file)

                def verify_slots(_target, _bindings, _observed):
                    if failure in ["network", "backup_network"]: raise host.Refusal("browser_proxy_verification")
                    if failure in ["config_race", "backup_config_race"]: browser_path.write_bytes(b"operator-edit")
                    if failure == "recreated" and len(started) == 2: return [{**slots[0], "proxyId": "3"*64}]
                    return slots

                def verified(target, references, identities):
                    for service in target["services"]:
                        name = service["name"]
                        self.assertEqual(references[name], self.expected["containers"][name]["image"] if recovery
                                         else self.new if name == "dashboard" else new_proxy)
                        self.assertEqual(identities[name], "sha256:" + ("a" if recovery else "b")*64)
                    return {name: {"id": "2"*64, "image": references[name], "imageId": identities[name]}
                            for name in references}

                for file in ["compose.before", "browser.before", "database.dump"]:
                    (self.operation / file).unlink(missing_ok=True)
                with patch.object(host, "inspect", return_value=self.expected), patch.object(host, "configured", side_effect=configured), \
                        patch.object(host, "command", side_effect=execute), patch.object(host, "image_identity", return_value="sha256:" + "b"*64), \
                        patch.object(host, "container", side_effect=lambda *_: {"running":
                            (failure == "early_start" and bool(started)) or
                            (stop_failure and (len(stopped) < 2 or failure == "stop_persistent"))}), \
                        patch.object(host, "verify_services", side_effect=verified), \
                        patch.object(host, "browser_slots", side_effect=verify_slots):
                    host.run(self.operation)
                result = json.loads((self.operation / "status.json").read_text())
                self.assertEqual(result["state"], "failed" if failure else "succeeded", result)
                self.assertEqual(result["migrationStarted"], not recovery, result)
                if failure in ["backup_recreate", "stop_partial"]:
                    self.assertTrue(result["recovered"], result)
                    self.assertEqual(len(started), 2)
                    self.assertEqual(self.compose.read_bytes(), self.source)
                    self.assertEqual(json.loads(browser_path.read_bytes()), {**browser, "networks": slots})
                elif failure:
                    self.assertFalse(result["recovered"])
                    self.assertEqual(len(started), 0 if failure == "stop_persistent" else 2 if failure == "recreated" else 1)
                if recovery:
                    self.assertEqual(len(stopped), 2)
                    self.assertFalse(any(arguments[0] == "/fixture/migrate" for arguments in self.calls))
                    if failure == "backup_config_race":
                        self.assertEqual(browser_path.read_bytes(), b"operator-edit")

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

    def test_upgrade_fixture_cleanup_continues_after_absent_or_unremovable_container(self):
        spec = importlib.util.spec_from_file_location("upgrade_fixture", Path(__file__).resolve().parents[6] / "scripts/smokeDashboardUpgrade.py")
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        for remains in [False, True]:
            calls = []
            def run(arguments, **_kwargs):
                calls.append(arguments)
                if arguments == ["docker", "rm", "--force", "fixture-a"]:
                    return subprocess.CompletedProcess(arguments, 1, b"", b"creation failed")
                if arguments[:2] == ["docker", "ps"]:
                    return subprocess.CompletedProcess(arguments, 0, b"still-present" if remains else b"", b"")
                return subprocess.CompletedProcess(arguments, 0, b"", b"")
            original = RuntimeError("original qualification failure")
            with patch.object(fixture.subprocess, "run", side_effect=run):
                try:
                    try:
                        raise original
                    finally:
                        fixture.cleanup({"fixture-a", "fixture-b"}, "fixture-network")
                except RuntimeError as error:
                    self.assertIs(error, original)
                self.assertIn(["docker", "rm", "--force", "fixture-b"], calls)
                self.assertIn(["docker", "network", "rm", "fixture-network"], calls)
            self.assertEqual(bool(getattr(original, "__notes__", [])), remains)

    def test_browser_fixture_cleanup_attempts_all_resources_and_preserves_error(self):
        spec = importlib.util.spec_from_file_location("browser_fixture", Path(__file__).resolve().parents[6] / "scripts/smokeBrowserDeployment.py")
        fixture = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture)
        calls = []
        def execute(arguments, **_kwargs):
            calls.append(arguments)
            if "down" in arguments or arguments == ["docker", "image", "rm", "fixture:candidate"]:
                raise RuntimeError("cleanup failure")
            return "remaining-image" if "ls" in arguments else ""
        original = RuntimeError("original browser failure")
        with patch.object(fixture, "command", side_effect=execute):
            try:
                try:
                    raise original
                finally:
                    fixture.cleanup(["docker", "compose"], ["fixture:candidate", "fixture:base"])
            except RuntimeError as error:
                self.assertIs(error, original)
            self.assertIn(["docker", "image", "rm", "fixture:base"], calls)
            self.assertIn("fixture:candidate", original.__notes__[0])
            calls.clear()
            with self.assertRaisesRegex(RuntimeError, "cleanup could not confirm"):
                fixture.cleanup(["docker", "compose"], ["fixture:candidate", "fixture:base"])
            self.assertIn(["docker", "image", "rm", "fixture:base"], calls)
        with patch.object(fixture, "command", side_effect=[RuntimeError("not found"), ""]):
            fixture.cleanup(None, ["fixture:missing"])


    def test_backup_root_certificate_fallback_preserves_url_authority(self):
        url = 'postgres://demo:synthetic@db.example.test/dashboard?sslmode=verify-full'
        environment = host.database_environment(url, 'system')
        self.assertEqual(environment['PGSSLROOTCERT'], 'system')
        self.assertEqual(environment['PGSSLMODE'], 'verify-full')
        self.assertNotIn('PGSSLROOTCERT', host.database_environment(url))
        self.assertEqual(host.database_environment(url + '&sslrootcert=%2Fprivate%2Fca.pem', 'system')['PGSSLROOTCERT'],
                         '/private/ca.pem')
        for invalid in ['', 'bad\npath', 'bad\rpath', 'bad\0path', 'x' * 8193]:
            with self.subTest(invalid=repr(invalid[:20])):
                with self.assertRaisesRegex(host.Refusal, 'backup_configuration'):
                    host.database_environment(url, invalid)

    def test_backup_entrypoint_forwards_only_selected_root_certificate(self):
        environment = {'HOMELAB_DASHBOARD_DATABASE_URL': 'postgres://demo:synthetic@db.example.test/dashboard?sslmode=verify-full',
                       'PGSSLROOTCERT': 'system', 'PGHOST': 'other.example.test', 'PGSSLMODE': 'disable',
                       'PGPASSWORD': 'unrelated', 'OPENSSL_CONF': '/unexpected/config', 'DOPPLER_TOKEN': 'not-for-child'}
        with patch.dict(os.environ, environment, clear=True), patch.object(host.sys, 'argv', ['runner.py', 'backup']), \
                patch.object(host.os, 'execve', side_effect=SystemExit) as execute:
            with self.assertRaises(SystemExit):
                host.main()
        binary, arguments, selected = execute.call_args.args
        self.assertEqual(binary, '/usr/bin/pg_dump')
        self.assertEqual(arguments, ['/usr/bin/pg_dump', '--format=custom', '--no-owner', '--no-acl'])
        self.assertEqual(selected['PGHOST'], 'db.example.test')
        self.assertEqual(selected['PGPASSWORD'], 'synthetic')
        self.assertEqual(selected['PGSSLMODE'], 'verify-full')
        self.assertEqual(selected['PGSSLROOTCERT'], 'system')
        self.assertNotIn('OPENSSL_CONF', selected)
        self.assertNotIn('DOPPLER_TOKEN', selected)


if __name__=="__main__":
    unittest.main()
