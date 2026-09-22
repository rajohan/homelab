"""Exercise updater safety against synthetic files and replaced commands, never a live daemon."""
import copy
import importlib.util
import hashlib
import io
import json
import os
import stat
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

    def test_loader_fragment_and_dispatcher_aliases(self):
        for target, executable, blocked in (
            ("/etc/ld.so.preload", False, True),
            ("/etc/ld.so.cache", False, True),
            ("/etc/ld.so.conf", False, True),
            ("/etc/ld-musl-x86_64.path", False, True),
            ("/etc/ld.so.preload.backup", False, False),
            ("/data/ld.so.conf", False, False),
            ("/usr/bin/unshare", True, True),
            ("/usr/bin/nsenter", True, True),
            ("/etc/ld.so.conf.d/extra.conf", False, True),
            ("/etc/ld.so.conf.d/nested/extra.conf", False, True),
            ("/etc/ld.so.conf.debug/extra.conf", False, False),
            ("/data/settings.conf", False, False),
            ("/lib64/ld-linux-x86-64.so.2", True, True),
            ("/lib/ld-musl-aarch64.so.1", True, True),
            ("/usr/bin/time", True, True),
            ("/usr/bin/prlimit", True, True),
            ("/usr/bin/sleep", True, False),
        ):
            with self.subTest(target=target):
                metadata = lambda name: {"mode": 0x08000000 if name == "/alias" else 0x80000000, "linkTarget": target if name == "/alias" else ""}
                paths, mounts = ({"/alias"}, ["/custom"]) if executable else ({"/vendor/server"}, ["/alias"])
                self.assertEqual(remote.qualify_startup_mounts(paths, mounts, metadata), [blocked])
                service = {"volumes": [{"type": "volume", "target": mounts[0]}]}
                startup = {"entrypoint": [next(iter(paths))], "command": ["/custom/start"] if executable else []}
                if blocked:
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service, startup, metadata)
                else:
                    remote.verify_code_mounts(service, startup, metadata)

    def test_all_loader_control_alias_forms_are_equivalent(self):
        for suffix in ("preload", "cache", "conf", "conf.d/nested/input"):
            target = "/etc/ld.so." + suffix
            links = {"/alias": target, "/relative": "etc/ld.so." + suffix, "/chain": "/alias", "/parent": "/etc"}
            metadata = lambda name: {"mode": 0x08000000 if name in links else 0x80000000, "linkTarget": links.get(name, "")}
            for destination in (target, "/alias", "/relative", "/chain", "/parent/ld.so." + suffix):
                for kind in ("volumes", "configs", "secrets"):
                    with self.subTest(suffix=suffix, destination=destination, kind=kind):
                        self.assertEqual(remote.qualify_startup_mounts({"/vendor/server"}, [destination], metadata), [True])
                        with self.assertRaises(remote.UpdateRefusal):
                            remote.verify_code_mounts({kind: [{"source": "synthetic", "type": "volume", "target": destination}]}, {"entrypoint": ["/vendor/server"]}, metadata)

    def test_namespace_utility_dispatch_without_entering_host_namespaces(self):
        with tempfile.TemporaryDirectory(prefix="homelab-dispatch-proof-") as temporary:
            # No namespace flags or target PID: unshare tests program dispatch only.
            result = subprocess.run(["/usr/bin/unshare", "--", "/bin/dash", "-c", "printf SYNTHETIC_EXECUTED"], cwd=temporary, env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, check=True, timeout=5)
            self.assertEqual(result.stdout, "SYNTHETIC_EXECUTED")
            # nsenter requires a namespace selection on some versions. Read its
            # grammar instead of entering any host namespace as a test fixture.
            result = subprocess.run(["/usr/bin/nsenter", "--help"], cwd=temporary, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"}, capture_output=True, text=True, check=True, timeout=5)
            self.assertIn("program", result.stdout)

    def test_actual_dynamic_loader_time_and_prlimit_execute_their_program(self):
        loader = next(path for path in ("/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1") if Path(path).exists())
        for prefix in ([loader], ["/usr/bin/time", "-p"], ["/usr/bin/prlimit", "--nofile=64", "--"]):
            with self.subTest(prefix=prefix), tempfile.TemporaryDirectory(prefix="homelab-dispatch-proof-") as temporary:
                # Use an actual ELF shell, not a multicall coreutils dispatcher
                # whose argv[0] changes under direct loader invocation.
                result = subprocess.run([*prefix, "/bin/dash", "-c", "printf SYNTHETIC_EXECUTED"], cwd=temporary, env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "SYNTHETIC_EXECUTED")

    def test_namespace_image_pins_are_immutable_and_same_reference(self):
        installed, digest = "sha256:" + "a" * 64, "sha256:" + "b" * 64
        row = ["c" * 64, "fixture-worker", "postgres:fixture-owned", installed, "running", "", "fixture", "worker", "", "", "", []]
        for mode in ("valid", "foreign", "empty", "wrong-id"):
            with self.subTest(mode=mode):
                def command(args, **options):
                    if args[4] == "{{json .RepoDigests}}":
                        return json.dumps([] if mode == "empty" else [("foreign/example" if mode == "foreign" else "postgres") + "@" + digest])
                    self.assertEqual(args[-1], row[2] + "@" + digest)
                    return "sha256:" + "f" * 64 if mode == "wrong-id" else installed
                with patch.object(remote, "command", side_effect=command):
                    if mode == "valid":
                        self.assertEqual(remote.pin_namespace_images([row], "root"), {"worker": row[2] + "@" + digest})
                    else:
                        with self.assertRaises(remote.UpdateRefusal):
                            remote.pin_namespace_images([row], "root")
        self.assertTrue(remote.matches_configured_image(row[2] + "@" + digest, row[2]))
        self.assertFalse(remote.matches_configured_image("postgres:other@" + digest, row[2]))
        self.assertFalse(remote.matches_configured_image(row[2] + "@sha256:short", row[2]))

    def test_loader_and_project_manifests_are_code_mounts(self):
        for kind in ("volumes", "configs", "secrets"):
            for target in ("/etc/ld.so.preload", "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld-musl-x86_64.path", "/app/package.json"):
                with self.subTest(kind=kind, target=target):
                    mount = {"target": target, "source": "synthetic-fixture"}
                    if kind == "volumes":
                        mount["type"] = "volume"
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts({kind: [mount]}, {"entrypoint": ["/vendor/server"]})
        metadata = lambda name: {"mode": 0x08000000 if name == "/app/manifest-alias" else 0x80000000 if name in ("/", "/app", "/etc", "/data") else 0, "linkTarget": "package.json" if name == "/app/manifest-alias" else ""}
        for target, blocked in (("/app/manifest-alias", True), ("/data/settings.json", False), ("/etc", True)):
            with self.subTest(target=target):
                service = {"volumes": [{"type": "volume", "target": target}]}
                startup = {"entrypoint": ["node", "."], "working_dir": "/app"}
                if blocked:
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service, startup, metadata)
                else:
                    remote.verify_code_mounts(service, startup, metadata)

    def test_actual_append_function_unset_and_tar_dispatch(self):
        with tempfile.TemporaryDirectory(prefix="homelab-search-proof-") as temporary:
            root = Path(temporary)
            executable = root / "fixture_run"
            executable.write_text("#!/bin/sh\nprintf SYNTHETIC_EXECUTED\n")
            executable.chmod(0o700)
            for expression in ('PATH+="$1"; fixture_run', 'PATH="$1"; unset -f PATH; fixture_run', 'export PATH+="$1"; fixture_run'):
                result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", expression, "fixture", str(root)], env={"PATH": "/usr/bin:/bin:", "HOME": temporary}, check=True, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.stdout, "SYNTHETIC_EXECUTED")
            archive = root / "archive.tar"
            payload = root / "payload"
            payload.write_text("synthetic")
            with tarfile.open(archive, "w") as stream:
                stream.add(payload, arcname="payload")
            result = subprocess.run(["tar", "-xf", str(archive), "--to-command=" + str(executable)], check=True, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.stdout, "SYNTHETIC_EXECUTED")

    def test_relative_symlink_targets_use_resolved_parent(self):
        for links, code, mount, blocked in [
            ({"/bin": "usr/bin", "/usr/bin/sh": "dash"}, "/bin/sh", "/data", False),
            ({"/vendor/start": "../custom/start"}, "/vendor/start", "/custom", True),
            ({"/vendor/start": "../bridge/../start", "/bridge": "custom/dir"}, "/vendor/start", "/custom", True),
            ({"/storage": "./custom"}, "/custom/start", "/storage", True),
            ({"/vendor/start": "../custom/dir/../../usr/bin/sleep"}, "/vendor/start", "/custom", False),
            ({"/vendor/start": "start"}, "/vendor/start", "/data", True),
            ({"/vendor/start": "next", "/vendor/next": "start"}, "/vendor/start", "/data", True),
        ]:
            with self.subTest(links=links):
                metadata = lambda name: {"mode": 0x08000000 if name in links else 0x80000000, "linkTarget": links.get(name, "")}
                self.assertEqual(remote.qualify_startup_mounts({code}, [mount], metadata), [blocked])

    def test_actual_brace_ansi_sed_and_directory_stack_execution(self):
        with tempfile.TemporaryDirectory(prefix="homelab-dispatch-proof-") as temporary:
            root = Path(temporary)
            script = root / "start"
            script.write_text("#!/bin/sh\nprintf SYNTHETIC_EXECUTED\n")
            script.chmod(0o755)
            for expression in [
                str(root) + "/{start,missing}",
                "$'" + str(root) + "/sta\\x72t'",
                'pushd "$1" >/dev/null; ./start',
                'pushd "$1" >/dev/null; pushd / >/dev/null; popd >/dev/null; ./start',
            ]:
                result = subprocess.run(["/bin/bash", "-c", expression, "fixture", str(root)], check=True, capture_output=True, text=True)
                self.assertEqual(result.stdout, "SYNTHETIC_EXECUTED")
            result = subprocess.run(["sed", "-n", "-e", "1e " + str(script)], input="synthetic\n", check=True, capture_output=True, text=True)
            self.assertEqual(result.stdout, "SYNTHETIC_EXECUTED")

    def test_actual_stdin_history_and_shell_variable_programs(self):
        with tempfile.TemporaryDirectory(prefix="homelab-shell-state-") as temporary:
            root = Path(temporary)
            script = root / "start"
            script.write_text("#!/bin/sh\nprintf executed\n")
            script.chmod(0o700)
            history = root / "commands"
            history.write_text(str(script) + "\n")
            expressions = ["cat \"$1/start\" | /bin/sh", "history -r \"$1/commands\"; fc -s", "printf -v PATH '%s' \"$1\"; start", "printf -vPATH '%s' \"$1\"; start"]
            for expression in expressions:
                result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", expression, "fixture", temporary], env={"PATH": "/usr/bin:/bin", "HOME": temporary, "HISTFILE": "/dev/null"}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "executed")

    def test_link_parent_traversal_survives_all_startup_inputs(self):
        links = {"/alias": "/custom/dir", "/entry": "/alias/../start"}
        def metadata(name):
            return {"mode": 0x08000000 if name in links else 0x80000000, "linkTarget": links.get(name, "")}
        for startup in ({"entrypoint": ["/alias/../start"]}, {"entrypoint": ["./start"], "working_dir": "/alias/.."}, {"entrypoint": ["start"], "environment": ["PATH=/alias/.."]}, {"entrypoint": ["/vendor/server"], "healthcheck": {"test": ["CMD", "/alias/../start"]}}, {"entrypoint": ["/entry"]}):
            paths = remote.startup_code_paths(startup)
            self.assertIsNotNone(paths)
            self.assertEqual(remote.qualify_startup_mounts(paths, ["/custom"], metadata), [True])
            with self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts({"volumes": [{"type": "volume", "target": "/custom"}]}, startup, metadata)
        self.assertEqual(remote.qualify_startup_mounts({"/custom/start"}, ["/alias/.."], metadata), [True])
        self.assertEqual(remote.qualify_startup_mounts({"/alias/../../outside"}, ["/custom"], metadata), [False])

    def test_actual_kernel_resolves_links_before_parent_components(self):
        with tempfile.TemporaryDirectory(prefix="homelab-path-traversal-") as temporary:
            root = Path(temporary)
            (root / "custom/dir").mkdir(parents=True)
            (root / "alias").symlink_to(root / "custom/dir")
            (root / "entry").symlink_to(root / "alias/../start")
            script = root / "custom/start"
            script.write_text("#!/bin/sh\nprintf executed\n")
            script.chmod(0o700)
            for executable in (str(root / "alias") + "/../start", str(root / "entry")):
                result = subprocess.run([executable], env={"PATH": "/usr/bin:/bin"}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "executed")

    def test_helper_exception_never_overrides_startup_healthcheck_hook_or_unknown_metadata(self):
        helper = "/opt/homelab/logout-worker.js"
        base = {"entrypoint": ["/vendor/server"]}
        metadata = lambda name: {"mode": 0x80000000, "linkTarget": ""}
        for kind in ("volumes", "configs", "secrets"):
            service = {kind: [{"target": helper}]}
            remote.verify_code_mounts(service, base, metadata)
            for startup in ({"entrypoint": ["node", helper]}, {**base, "healthcheck": {"test": ["CMD", "node", helper]}}, {"entrypoint": ["sh"]}):
                with self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts(service, startup, metadata)
            with self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts(service, base, lambda name: None)
            for hook in ("post_start", "pre_stop"):
                with self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts({**service, hook: [{"command": ["node", helper]}]}, base, metadata)

    def test_stdin_and_history_effective_healthchecks_can_be_disabled(self):
        for command in (["sh"], ["node"], ["bash", "-c", "history -r /custom/commands; fc -s"], ["bash", "-c", "printf -v PATH /custom; start"]):
            defaults = {"entrypoint": ["/vendor/server"], "healthcheck": {"Test": ["CMD", *command]}}
            service = {"volumes": [{"target": "/custom"}]}
            with self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts(service, remote.compose_startup({}, defaults))
            remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"disable": True}}, defaults))

    def test_actual_module_and_cdpath_execution(self):
        with tempfile.TemporaryDirectory(prefix="homelab-program-input-") as temporary:
            root = Path(temporary)
            (root / "program.py").write_text("print('executed', end='')\n")
            (root / "app").mkdir()
            (root / "app/start").write_text("#!/bin/sh\nprintf executed\n")
            (root / "app/start").chmod(0o700)
            cases = [([sys.executable, "-Im", "doctest", str(root / "program.py")], {}), (["/bin/sh", "-c", "cd app >/dev/null; ./start"], {"CDPATH": temporary})]
            for arguments, environment in cases:
                result = subprocess.run(arguments, cwd="/", env={"PATH": "/usr/bin:/bin", "HOME": temporary, **environment}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "executed")

    def test_metadata_only_symlink_mount_qualification(self):
        for links, code, mount, expected in [({"/vendor/start": "/custom/start"}, "/vendor/start", "/custom", True), ({"/vendor": "/custom"}, "/vendor/start", "/custom", True), ({"/storage": "/custom"}, "/custom/start", "/storage", True), ({"/bin": "/usr/bin"}, "/bin/sleep", "/custom", False), ({"/vendor": "/vendor"}, "/vendor/start", "/custom", True)]:
            def metadata(name):
                return {"mode": 0x08000000 if name in links else 0x80000000, "linkTarget": links.get(name, "")}
            with self.subTest(links=links):
                self.assertEqual(remote.qualify_startup_mounts({code}, [mount], metadata), [expected])
        self.assertEqual(remote.qualify_startup_mounts({"/vendor/start"}, ["/custom"], lambda name: None), [True])
        self.assertEqual(remote.qualify_startup_mounts(None, ["/custom"], lambda name: self.fail("Unqualified programs do not need filesystem reads")), [True])

    def test_absolute_link_components_are_normalized_before_matching_mounts(self):
        for target, mount, expected in [
            ("/vendor/../custom/start", "/custom", True),
            ("/custom/./start", "/custom", True),
            ("/vendor/../../custom/start", "/custom", True),
            ("/vendor/../usr/bin/./sleep", "/custom", False),
        ]:
            for missing in (False, True):
                def metadata(name):
                    cleaned = remote.posixpath.normpath(name)
                    if cleaned == "/vendor/start":
                        return {"mode": 0x08000000, "linkTarget": target}
                    if cleaned != "/" and missing:
                        return None
                    return {"mode": 0x80000000, "linkTarget": ""}
                # The image's /vendor parent must exist to reach its symlink.
                def image_metadata(name):
                    return {"mode": 0x80000000, "linkTarget": ""} if name == "/vendor" else metadata(name)
                with self.subTest(target=target, missing=missing):
                    self.assertEqual(remote.qualify_startup_mounts({"/vendor/start"}, [mount], image_metadata), [expected])
        def alias_metadata(name):
            return {"mode": 0x08000000, "linkTarget": "/vendor/../custom/."} if name == "/storage" else {"mode": 0x80000000, "linkTarget": ""}
        self.assertEqual(remote.qualify_startup_mounts({"/custom/start"}, ["/storage"], alias_metadata), [True])

    def test_image_qualification_never_starts_code_and_cleans_on_refusal(self):
        for link in (False, True):
            calls, owner = [], []
            def command(arguments, **options):
                calls.append(arguments)
                if arguments[1] == 'create':
                    owner.append(arguments[arguments.index('--name') + 1])
                    self.assertIn('--read-only', arguments)
                    self.assertEqual(arguments[arguments.index('--network') + 1], 'none')
                    return 'a' * 64
                if arguments[1] == 'inspect':
                    self.assertEqual(arguments[-1], owner[0])
                    return json.dumps(['a' * 64, 'created', owner[0], 'sha256:' + 'b' * 64])
                if arguments[1] == 'rm':
                    self.assertEqual(arguments[2:], ['--volumes', 'a' * 64])
                    return 'a' * 64
                self.fail('Unexpected image qualification command')
            def metadata(name):
                return {'mode': 0x08000000 if link and name == '/vendor/start' else 0x80000000, 'linkTarget': '/custom/start' if link and name == '/vendor/start' else ''}
            with patch.object(remote, 'command', side_effect=command), patch.object(remote, 'container_path_stat', return_value=metadata):
                if link:
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_image_mounts({'volumes': [{'type': 'volume', 'target': '/custom'}]}, {'entrypoint': ['/vendor/start']}, 'sha256:' + 'b' * 64)
                else:
                    remote.verify_image_mounts({'volumes': [{'type': 'volume', 'target': '/custom'}]}, {'entrypoint': ['/vendor/start']}, 'sha256:' + 'b' * 64)
            self.assertEqual([call[1] for call in calls], ['create', 'inspect', 'rm'])

    def test_image_qualification_cleans_uncertain_create_only_with_exact_ownership(self):
        for receipt in ('warning\n' + 'a' * 64, RuntimeError('Command deadline exceeded')):
            for mismatch in (None, 'owner', 'state', 'image', 'missing'):
                calls, owner = [], []
                def command(arguments, **options):
                    calls.append(arguments)
                    if arguments[1] == 'create':
                        owner.append(arguments[arguments.index('--name') + 1])
                        if isinstance(receipt, Exception):
                            raise receipt
                        return receipt
                    if arguments[1] == 'inspect':
                        self.assertEqual(arguments[-1], owner[0])
                        if mismatch == 'missing':
                            raise RuntimeError('No created container')
                        return json.dumps(['a' * 64, 'running' if mismatch == 'state' else 'created', 'foreign' if mismatch == 'owner' else owner[0], 'sha256:' + ('c' if mismatch == 'image' else 'b') * 64])
                    self.assertEqual(arguments, ['/usr/bin/docker', 'rm', '--volumes', 'a' * 64])
                    return 'a' * 64
                with self.subTest(receipt=str(receipt), mismatch=mismatch), patch.object(remote, 'command', side_effect=command), patch.object(remote, 'container_path_stat', side_effect=AssertionError('Invalid create receipt cannot qualify files')):
                    with self.assertRaises(RuntimeError):
                        remote.verify_image_mounts({'volumes': [{'type': 'volume', 'target': '/custom'}]}, {'entrypoint': ['/vendor/start']}, 'sha256:' + 'b' * 64)
                self.assertEqual([call[1] for call in calls], ['create', 'inspect', 'rm'] if mismatch is None else ['create', 'inspect'])

    def test_actual_alias_inline_python_awk_and_find_dispatch(self):
        with tempfile.TemporaryDirectory(prefix="homelab-indirect-program-") as temporary:
            script = Path(temporary) / "start"
            script.write_text("#!/bin/sh\nprintf executed\n")
            script.chmod(0o700)
            program = Path(temporary) / "program.py"
            program.write_text("print('executed', end='')\n")
            awk = Path(temporary) / "program.awk"
            awk.write_text('BEGIN {printf "executed"}\n')
            commands = [
                ["/bin/bash", "--noprofile", "--norc", "-O", "expand_aliases", "-c", "alias run='" + str(script) + "'\nrun"],
                [sys.executable, "-Ic", "import sys;exec(open(sys.argv[1]).read())", str(program)],
                ["/usr/bin/awk", "-f", str(awk)],
                ["/usr/bin/find", temporary, "-maxdepth", "0", "-exec", str(script), ";"],
            ]
            for command in commands:
                result = subprocess.run(command, env={"PATH": "/usr/bin:/bin", "HOME": temporary}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "executed")

    def test_indirect_program_healthchecks_preserve_disabled_modes(self):
        for command in (["/bin/bash", "-O", "expand_aliases", "-c", "alias run=/custom/start\nrun"], ["python", "-Ic", "SYNTHETIC_PRIVATE"], ["awk", "-f", "/custom/program.awk"], ["find", "/tmp", "-execdir", "/custom/start", "{}", ";"]):
            defaults = {"entrypoint": ["/vendor/server"], "healthcheck": {"Test": ["CMD", *command]}}
            for kind in ("bind", "volume", "tmpfs"):
                service = {"volumes": [{"type": kind, "target": "/custom"}]}
                with self.subTest(command=command, kind=kind):
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"interval": "1s"}}, defaults))
                    remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"disable": True}}, defaults))
                    self.assertNotIn("SYNTHETIC_PRIVATE", repr(remote.startup_code_paths(remote.compose_startup({}, defaults))))

    def test_actual_assignment_prefixed_coproc_uses_external_lookup(self):
        with tempfile.TemporaryDirectory(prefix="homelab-coproc-command-") as temporary:
            executable = Path(temporary) / "coproc"
            executable.write_text('#!/bin/sh\nprintf "%s:%s" "$FOO" "$1"\n')
            executable.chmod(0o700)
            for keyword in ("coproc", "co\\\nproc"):
                result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", "FOO=x " + keyword + " /vendor/server"], env={"PATH": temporary + ":/usr/bin:/bin", "HOME": temporary}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "x:/vendor/server")

    def test_image_shell_healthcheck_effective_defaults(self):
        for kind in ("bind", "volume", "tmpfs"):
            service = {"volumes": [{"type": kind, "target": "/custom"}]}
            defaults = {"entrypoint": ["/vendor/server"], "shell": ["/custom/shell", "-c", "SYNTHETIC_PRIVATE"], "healthcheck": {"Test": ["CMD-SHELL", "/vendor/check"]}}
            for override in ({}, {"healthcheck": {"interval": "1s"}}, {"healthcheck": {"test": ["CMD-SHELL", "/vendor/other"]}}):
                with self.subTest(kind=kind, override=override), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts(service, remote.compose_startup(override, defaults))
            for check in ({"disable": True}, {"test": ["NONE"]}, {"test": ["CMD", "/vendor/check"]}):
                remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": check}, defaults))
            for shell in (None, [], ["/bin/sh", "-c"]):
                remote.verify_code_mounts(service, remote.compose_startup({}, {**defaults, "shell": shell}))
            paths = remote.startup_code_paths(defaults)
            self.assertNotIn("SYNTHETIC_PRIVATE", repr(paths))

    def test_inherited_storage_requires_separate_qualification(self):
        # References are service/container identifiers, never host paths to stat.
        for reference in ("code-provider", "code-provider:ro", "code-provider:rw", "container:fixture", "container:fixture:ro", "container:fixture:rw"):
            for startup in ({}, {"entrypoint": ["/custom/start"]}, {"entrypoint": ["/vendor/server"]}, {"healthcheck": {"test": ["CMD", "/custom/check"]}}):
                service = {"volumes_from": [reference]}
                before = copy.deepcopy(service)
                with self.subTest(reference=reference, startup=startup), patch.object(remote.Path, "stat", side_effect=AssertionError("Inherited storage references are not paths")):
                    with self.assertRaises(remote.UpdateRefusal) as caught:
                        remote.verify_code_mounts(service, startup)
                    self.assertEqual(caught.exception.reason, "local_code_override")
                    self.assertEqual(service, before)
        remote.verify_code_mounts({"volumes_from": [], "entrypoint": ["/vendor/server"]})
        remote.verify_code_mounts({"entrypoint": ["/vendor/server"], "volumes": [{"type": "volume", "source": "ordinary-data", "target": "/data"}]})

    def test_coproc_in_effective_and_disabled_healthchecks(self):
        for expression in ("coproc /custom/check", "co\\\nproc /custom/check", "/bin/true; coproc /custom/check"):
            defaults = {"entrypoint": ["/vendor/server"], "healthcheck": {"Test": ["CMD", "/bin/bash", "-c", expression]}}
            for kind in ("bind", "volume", "tmpfs"):
                service = {"volumes": [{"type": kind, "target": "/custom"}]}
                with self.subTest(expression=expression, kind=kind):
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service, remote.compose_startup({}, defaults))
                    with self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"interval": "1s"}}, defaults))
                    remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"disable": True}}, defaults))
                    remote.verify_code_mounts({}, remote.compose_startup({}, defaults))

    def test_actual_bash_coproc_executes_its_operand(self):
        with tempfile.TemporaryDirectory(prefix="homelab-coproc-") as temporary:
            script = Path(temporary) / "start"
            marker = Path(temporary) / "marker"
            script.write_text('#!/bin/sh\nprintf executed > "$1"\n')
            script.chmod(0o700)
            for keyword in ("coproc", "co\\\nproc"):
                marker.unlink(missing_ok=True)
                result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", keyword + ' "$1" "$2"; wait "$!"', "fixture", str(script), str(marker)], env={"PATH": "/usr/bin:/bin", "HOME": temporary}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "")
                self.assertEqual(marker.read_text(), "executed")

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

    def test_compound_shell_healthchecks_fail_closed_only_with_mounts(self):
        for expression in ("( /custom/check )", "{ /custom/check; }", "if /custom/check; then true; fi", "while /custom/check; do true; done"):
            for kind in ("bind", "volume", "tmpfs"):
                defaults = {"entrypoint": ["/vendor/server"], "healthcheck": {"Test": ["CMD-SHELL", expression]}}
                for override in ({}, {"healthcheck": {"interval": "1s"}}, {"healthcheck": {"test": ["CMD-SHELL", expression]}}):
                    service = {**override, "volumes": [{"type": kind, "target": "/custom"}]}
                    with self.subTest(expression=expression, kind=kind, override=override), self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service, remote.compose_startup(service, defaults))
                remote.verify_code_mounts({}, remote.compose_startup({}, defaults))
                remote.verify_code_mounts({"volumes": [{"type": kind, "target": "/custom"}]}, remote.compose_startup({"healthcheck": {"disable": True}}, defaults))

    def test_dispatch_healthchecks_preserve_query_only_and_disabled_modes(self):
        for expression in ("command /custom/check", "command -p -- /custom/check", "builtin command /custom/check", "command cd /custom; ./check"):
            for kind in ("bind", "volume", "tmpfs"):
                defaults = {"entrypoint": ["/vendor/server"], "healthcheck": {"Test": ["CMD-SHELL", expression]}}
                service = {"volumes": [{"type": kind, "target": "/custom"}]}
                with self.subTest(healthcheck=expression, kind=kind), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"interval": "1s"}}, defaults))
                for test in (["NONE"], ["CMD-SHELL", "command -v /custom/check"], ["CMD-SHELL", "builtin command -Vp /custom/check"]):
                    remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"test": test}}, defaults))
    def test_real_bash_dispatch_distinguishes_execution_from_information(self):
        with tempfile.TemporaryDirectory(prefix="homelab-dispatch-test-") as temporary:
            script = Path(temporary) / "start"
            script.write_text("#!/bin/sh\nprintf executed\n")
            script.chmod(0o700)
            for expression, executes in (("command -p -- \"$1\"", True), ("builtin command -- \"$1\"", True), ("command -pv -- \"$1\"", False), ("builtin command -v \"$1\"", False)):
                result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-c", expression, "fixture", str(script)], capture_output=True, text=True, check=True, timeout=5, env={"PATH": "/usr/bin:/bin", "HOME": temporary})
                self.assertEqual(result.stdout.strip(), "executed" if executes else str(script))

    def test_code_loading_environment_is_merged_without_leaking_values(self):
        for kind in ("bind", "volume", "tmpfs"):
            service = {"volumes": [{"type": kind, "target": "/custom"}]}
            defaults = {"entrypoint": ["/vendor/server"], "environment": ["LD_PRELOAD=/custom/SYNTHETIC_PRIVATE"]}
            for override in ({}, {"environment": {"APP_CONFIG": "private"}}, {"environment": ["LD_PRELOAD=/custom/SYNTHETIC_PRIVATE"]}):
                with self.subTest(kind=kind, override=override), self.assertRaises(remote.UpdateRefusal) as error:
                    remote.verify_code_mounts(service, remote.compose_startup(override, defaults))
                self.assertNotIn("SYNTHETIC_PRIVATE", str(error.exception))
            for value in ("", None):
                remote.verify_code_mounts(service, remote.compose_startup({"environment": {"LD_PRELOAD": value}}, defaults))
            remote.verify_code_mounts({}, defaults)

    def test_compose_lifecycle_hooks_qualify_effective_startup(self):
        for kind in ("post_start", "pre_stop"):
            for command in (["/custom/start"], "nice /custom/start", ["bash", "-O", "extglob", "/custom/start"], ["java", "-jar", "/custom/app.jar"], "trap /custom/start EXIT; true"):
                for mount in ("bind", "volume", "tmpfs"):
                    service = {kind: [{"command": command}], "volumes": [{"type": mount, "target": "/custom"}]}
                    with self.subTest(kind=kind, command=command, mount=mount), self.assertRaises(remote.UpdateRefusal):
                        remote.verify_code_mounts(service, {"entrypoint": ["/vendor/server"]})
            for hook in ({"command": ["./start"], "working_dir": "/custom"}, {"command": ["/vendor/check"], "environment": {"LD_PRELOAD": "/custom/SYNTHETIC_PRIVATE"}}):
                with self.subTest(hook=hook), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts({kind: [hook], "volumes": [{"target": "/custom"}]}, {"entrypoint": ["/vendor/server"]})
            with self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts({kind: [{"command": ["./start"]}], "volumes": [{"target": "/custom"}]}, {"entrypoint": ["/vendor/server"], "working_dir": "/custom"})
            remote.verify_code_mounts({kind: [{"command": ["/vendor/check", "/custom/config"]}], "volumes": [{"target": "/custom"}]}, {"entrypoint": ["/vendor/server"]})

    def test_separate_image_compose_init_hooks_require_qualification(self):
        with self.assertRaises(remote.UpdateRefusal):
            remote.verify_code_mounts({"pre_start": [{"image": "fixture", "command": ["/custom/start"]}], "volumes": [{"target": "/custom"}]})

    def test_jvm_artifact_mount_suffixes(self):
        for extension in ("jar", "class", "jmod", "java"):
            with self.subTest(extension=extension), self.assertRaises(remote.UpdateRefusal):
                remote.verify_code_mounts({"entrypoint": ["/vendor/server"], "volumes": [{"target": "/custom/plugin." + extension}]})
        remote.verify_code_mounts({"entrypoint": ["/vendor/server"], "volumes": [{"target": "/custom/data.zip"}]})

    def test_real_shell_option_and_deferred_handler_semantics(self):
        with tempfile.TemporaryDirectory(prefix="homelab-shell-options-") as temporary:
            script = Path(temporary) / "start"
            script.write_text("printf executed")
            for options in (["-O", "extglob"], ["-o", "pipefail"], ["+O", "extglob"], ["-eO", "extglob"]):
                result = subprocess.run(["/bin/bash", *options, str(script)], check=True, capture_output=True, text=True, timeout=5, env={"PATH": "/usr/bin:/bin", "HOME": temporary})
                self.assertEqual(result.stdout, "executed")
            result = subprocess.run(["/bin/bash", "-c", "trap 'printf deferred' EXIT; printf main"], check=True, capture_output=True, text=True, timeout=5, env={"PATH": "/usr/bin:/bin", "HOME": temporary})
            self.assertEqual(result.stdout, "maindeferred")

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

    def test_path_inheritance_and_healthcheck_scope(self):
        defaults = {"entrypoint": ["/bin/sh", "-c"], "command": ["PATH=/usr/bin /bin/true"], "environment": ["PATH=/custom:/usr/bin"], "healthcheck": {"Test": ["CMD", "start"]}}
        for kind in ("bind", "volume", "tmpfs"):
            service = {"volumes": [{"type": kind, "target": "/custom"}]}
            for overrides in ({}, {"environment": {"APP_CONFIG": "SYNTHETIC_PRIVATE"}}):
                with self.subTest(kind=kind, overrides=overrides), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts(service, remote.compose_startup(overrides, defaults))
            remote.verify_code_mounts(service, remote.compose_startup({"environment": {"PATH": "/usr/bin:/bin"}}, defaults))
        paths = remote.startup_code_paths({"entrypoint": ["node", "--max-old-space-size=128"], "command": ["/vendor/app.js", "/custom/data"]})
        self.assertIsNotNone(paths)
        self.assertNotIn("/custom/data", paths)

    def test_real_shell_search_and_parameter_operands(self):
        with tempfile.TemporaryDirectory(prefix="homelab-shell-search-") as temporary:
            script = Path(temporary) / "start"
            script.write_text("#!/bin/sh\nprintf executed")
            script.chmod(0o700)
            environment = {"PATH": temporary + ":/usr/bin:/bin", "SCRIPT": str(script), "HOME": temporary}
            for expression in ("start", 'sh "$SCRIPT"', 'command sh "$SCRIPT"'):
                result = subprocess.run(["/bin/sh", "-c", expression], env=environment, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "executed")
            result = subprocess.run(["/bin/sh", "-c", "printf '%s' '$SCRIPT'"], env=environment, capture_output=True, text=True, check=True, timeout=5)
            self.assertEqual(result.stdout, "$SCRIPT")

    def test_expanded_interpreter_options_are_not_guessed(self):
        self.assertIsNone(remote.startup_code_paths({"entrypoint": ["/bin/sh", "-c"], "command": ["python -$OPTIONS /vendor/app.py"]}))
        self.assertIsNotNone(remote.startup_code_paths({"entrypoint": ["/bin/sh", "-c"], "command": ["python /vendor/app.py --mode=$OPTIONS"]}))

    def test_actual_bash_exec_operand_and_hash_dispatch(self):
        with tempfile.TemporaryDirectory(prefix="homelab-shell-dispatch-") as temporary:
            script = Path(temporary) / "start"
            script.write_text("#!/bin/sh\nprintf executed")
            script.chmod(0o700)
            for options in (["-a", "synthetic"], ["-asynthetic"], ["-cla", "synthetic"], ["-c", "-l", "-a", "synthetic"], ["--"]):
                result = subprocess.run(["/bin/bash", "-c", 'exec "$@"', "fixture", *options, str(script)], env={"PATH": "/usr/bin:/bin", "HOME": temporary}, capture_output=True, text=True, check=True, timeout=5)
                self.assertEqual(result.stdout, "executed")
            result = subprocess.run(["/bin/bash", "-c", 'hash -p "$1" fixture_run; fixture_run', "fixture", str(script)], env={"PATH": "/usr/bin:/bin", "HOME": temporary}, capture_output=True, text=True, check=True, timeout=5)
            self.assertEqual(result.stdout, "executed")

    def test_non_node_preloads_and_dispatch_inherited_healthchecks(self):
        for command in (["ruby", "-r/custom/hook", "/vendor/app.rb"], ["/bin/bash", "-c", "hash -p /custom/start run; run"], ["/bin/bash", "-c", "exec -a synthetic /custom/start"], ["tini", "-p", "SIGTERM", "--", "/custom/start"]):
            defaults = {"entrypoint": ["/vendor/server"], "healthcheck": {"Test": ["CMD", *command]}}
            for kind in ("bind", "volume", "tmpfs"):
                service = {"volumes": [{"type": kind, "target": "/custom"}]}
                with self.subTest(command=command, kind=kind), self.assertRaises(remote.UpdateRefusal):
                    remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"interval": "1s"}}, defaults))
                remote.verify_code_mounts(service, remote.compose_startup({"healthcheck": {"disable": True}}, defaults))

    def docker_fixture(self, mode="running", mutate=False, fail=False, with_environment=False, manifest_store=False, wrong_pull=False, new_consumer=None, directory_sync_error=False):
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

            real_fsync = os.fsync
            def sync(descriptor):
                if directory_sync_error and stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    raise OSError("Synthetic directory sync failure")
                real_fsync(descriptor)
            with patch.object(remote, "command", side_effect=command), patch.object(remote, "progress"), patch.object(remote.os, "fsync", side_effect=sync):
                if directory_sync_error:
                    with self.assertRaisesRegex(OSError, "directory sync failure"):
                        remote.docker_update(driver, item, True)
                elif mutate or fail or wrong_pull or new_consumer:
                    with self.assertRaises(RuntimeError):
                        remote.docker_update(driver, item, True)
                else:
                    self.assertEqual(remote.docker_update(driver, item, True), item["available"])
            contents = source.read_bytes()
            if with_environment:
                self.assertEqual(sum(call[0] == "/fixture/environment" for call in calls), 1)
            self.assertIn(b"synthetic-private-value", contents)
            self.assertFalse(list(directory.glob(".homelab-update-*")))
            if directory_sync_error:
                # The rename happened, but durability was not acknowledged. Do
                # not recreate containers or claim success (nor blindly undo it).
                self.assertIn(new.encode(), contents)
                self.assertFalse(installed)
                self.assertFalse(any("up" in call or "stop" in call for call in calls))
            elif wrong_pull or new_consumer:
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

    def test_all_namespace_consumers_are_qualified_before_pull(self):
        class PullBoundary(Exception):
            pass
        for state in ("running", "exited", "created"):
            for mode in ("pending", "live-removed-mount", "image-health", "hook", "loader", "relative-link", "ordinary", "unrelated"):
                with self.subTest(state=state, mode=mode), tempfile.TemporaryDirectory(prefix="homelab-peer-preflight-") as temporary:
                    directory = Path(temporary).resolve()
                    source = directory / "compose.yaml"
                    old = "example/web:1.0@sha256:" + "a" * 64
                    original = ("services:\n  root:\n    image: " + old + "\n").encode()
                    source.write_bytes(original)
                    installed = "sha256:" + "d" * 64
                    driver = {"name": "fixture-root-1", "project": "fixture", "service": "root", "directory": str(directory), "file": str(source), "imageFile": str(source), "namespaceDependents": ["middle", "leaf"]}
                    item = {"id": "docker:" + "a" * 64, "image": old, "installed": installed, "available": "sha256:" + "e" * 64, "availableImage": "docker.io/example/web:2.0@sha256:" + "b" * 64}
                    services = {name: {"image": old if name == "root" else "example/worker:1"} for name in ("root", "middle", "leaf", "unrelated")}
                    rows = [[character * 64, "/fixture-" + name + "-1", services[name]["image"], installed, state, "started", "fixture", name, "none", "", "", []] for character, name in zip("abc", ("root", "middle", "leaf"))]
                    base = {"entrypoint": ["/vendor/server"], "working_dir": "/", "environment": []}
                    lives = {row[0]: dict(base) for row in rows}
                    defaults = dict(base)
                    selected = services["unrelated" if mode == "unrelated" else "leaf"]
                    selected["volumes"] = [{"type": "volume", "target": "/custom"}]
                    if mode in ("pending", "unrelated"):
                        selected["entrypoint"] = ["/custom/start"]
                    elif mode == "live-removed-mount":
                        selected.pop("volumes")
                        rows[-1][11] = [{"Type": "volume", "Source": "fixture-code", "Destination": "/custom"}]
                        lives[rows[-1][0]] = {**base, "entrypoint": ["/custom/start"]}
                    elif mode == "image-health":
                        defaults["healthcheck"] = {"Test": ["CMD", "/custom/start"]}
                    elif mode == "hook":
                        selected["pre_stop"] = [{"command": ["/custom/start"]}]
                    elif mode == "loader":
                        selected["environment"] = {"LD_PRELOAD": "/custom/SYNTHETIC_PRIVATE"}
                    elif mode == "relative-link":
                        selected["entrypoint"] = ["/vendor/entry"]
                    calls, qualified = [], []
                    def metadata(name):
                        return {"mode": 0x08000000 if name == "/vendor/entry" else 0x80000000, "linkTarget": "../custom/start" if name == "/vendor/entry" else ""}
                    def command(arguments, **options):
                        calls.append(arguments)
                        if arguments[1] == "compose" and "config" in arguments:
                            effective = copy.deepcopy(services)
                            override = Path(arguments[len(arguments) - 1 - arguments[::-1].index("--file") + 1])
                            if override.name.startswith(".homelab-update-images-"):
                                for name, values in json.loads(override.read_text())["services"].items():
                                    effective[name].update(values)
                            return json.dumps({"services": effective})
                        if arguments[1] == "inspect" and arguments[3].startswith('{"entrypoint":'):
                            return json.dumps(lives[arguments[-1]])
                        if arguments[1:3] == ["image", "inspect"]:
                            if arguments[4] == "{{json .RepoDigests}}":
                                return json.dumps(["example/worker@sha256:" + "d" * 64])
                            return installed if arguments[4] == "{{.Id}}" else json.dumps(defaults)
                        if arguments[1] == "pull":
                            raise PullBoundary()
                        self.fail("Unexpected mutation or inspection: " + repr(arguments))
                    def image_mounts(service, startup, image):
                        qualified.append(image)
                        remote.verify_code_mounts(service, startup, metadata)
                    with patch.object(remote, "command", side_effect=command), patch.object(remote, "inspect_container", return_value=[*rows[0][1:5], "fixture", "root"]), patch.object(remote, "namespace_snapshot", return_value=rows[0]), patch.object(remote, "prepare_namespace_plan", return_value=rows), patch.object(remote, "container_path_stat", return_value=metadata), patch.object(remote, "verify_image_mounts", side_effect=image_mounts), patch.object(remote, "progress"):
                        if mode in ("ordinary", "unrelated"):
                            with self.assertRaises(PullBoundary):
                                remote.docker_update(driver, item)
                            self.assertEqual(qualified, [installed] * 3)
                        else:
                            with self.assertRaises(remote.UpdateRefusal):
                                remote.docker_update(driver, item)
                            self.assertFalse(any(call[1] == "pull" for call in calls))
                    self.assertEqual(source.read_bytes(), original)

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

    def test_directory_sync_failure_stops_before_application_mutation(self):
        for mode in ("running", "exited", "created"):
            with self.subTest(mode=mode):
                self.docker_fixture(mode=mode, directory_sync_error=True)

    def test_atomic_replacement_syncs_file_then_rename_then_directory(self):
        with tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
            path = Path(temporary).resolve() / "compose.yaml"
            path.write_bytes(b"original")
            events, descriptors = [], []
            real_fsync, real_replace = os.fsync, os.replace
            def sync(descriptor):
                directory = stat.S_ISDIR(os.fstat(descriptor).st_mode)
                events.append("directory" if directory else "file")
                if directory:
                    descriptors.append(descriptor)
                real_fsync(descriptor)
            def replace(source, target):
                events.append("replace")
                real_replace(source, target)
            with patch.object(remote.os, "fsync", side_effect=sync), patch.object(remote.os, "replace", side_effect=replace):
                remote.atomic_content(path, b"changed", b"original")
                remote.atomic_content(path, b"original", b"changed")
            self.assertEqual(events, ["file", "replace", "directory"] * 2)
            self.assertEqual(path.read_bytes(), b"original")
            self.assertEqual(list(path.parent.iterdir()), [path])
            for descriptor in descriptors:
                with self.assertRaises(OSError):
                    os.fstat(descriptor)

    def test_atomic_directory_open_or_sync_failure_closes_owned_files(self):
        for stage in ("open", "sync"):
            with self.subTest(stage=stage), tempfile.TemporaryDirectory(prefix="homelab-updater-fixture-") as temporary:
                path = Path(temporary).resolve() / "compose.yaml"
                path.write_bytes(b"original")
                real_open, real_fsync = os.open, os.fsync
                descriptors = []
                def open_directory(name, flags, *args, **kwargs):
                    if flags & os.O_DIRECTORY and stage == "open":
                        raise OSError("Synthetic directory open failure")
                    descriptor = real_open(name, flags, *args, **kwargs)
                    if flags & os.O_DIRECTORY:
                        descriptors.append(descriptor)
                    return descriptor
                def sync(descriptor):
                    if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                        raise OSError("Synthetic directory sync failure")
                    real_fsync(descriptor)
                with patch.object(remote.os, "open", side_effect=open_directory), patch.object(remote.os, "fsync", side_effect=sync):
                    with self.assertRaisesRegex(OSError, "directory .* failure"):
                        remote.atomic_content(path, b"changed", b"original")
                self.assertEqual(path.read_bytes(), b"original" if stage == "open" else b"changed")
                self.assertEqual(list(path.parent.iterdir()), [path])
                for descriptor in descriptors:
                    with self.assertRaises(OSError):
                        os.fstat(descriptor)

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
