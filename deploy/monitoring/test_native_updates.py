"""Native release fixtures never invoke a real package manager or service."""
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from test_update_execution import remote


def version_output(component, version):
    if component in {'victoriametrics', 'vmalert', 'vmbackup'}:
        name = 'victoria-metrics' if component == 'victoriametrics' else component
        return name + '-20260921-120000-tags-v' + version + '-0-gabcd123'
    if component == 'traefik':
        return 'Version: ' + version + '\nGo version: go1.26.7'
    return component.replace('-exporter', '_exporter') + ', version v' + version + '\n  go version: go1.26.7'


class NativeBinaryTests(unittest.TestCase):
    """Verify every registered artifact layout, executable identity and state boundary."""

    def test_provider_versions_ignore_unrelated_runtime_versions(self):
        for component in remote.BINARY_RELEASES:
            with self.subTest(component=component):
                self.assertEqual(remote.binary_version(component, version_output(component, '1.2.3')), '1.2.3')
                with self.assertRaises(RuntimeError):
                    remote.binary_version(component, 'go1.26.7')

    def test_every_provider_verifies_its_exact_archive_and_reads_only_selected_binary(self):
        for component, (repository, asset, member, _, checksum) in remote.BINARY_RELEASES.items():
            for arch in ('amd64', 'arm64'):
                with self.subTest(component=component, arch=arch):
                    name = asset.format(version='1.2.3', arch=arch)
                    entry = member.format(version='1.2.3', arch=arch)
                    executable = b'\x7fELFsynthetic fixture'
                    stream = io.BytesIO()
                    if name.endswith('.zip'):
                        with zipfile.ZipFile(stream, 'w') as archive:
                            archive.writestr(entry, executable)
                            archive.writestr('../../not-extracted', 'unrelated')
                    else:
                        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
                            item = tarfile.TarInfo(entry); item.size = len(executable)
                            archive.addfile(item, io.BytesIO(executable))
                    content = stream.getvalue()
                    digest = hashlib.sha256(content).hexdigest()
                    base = 'https://github.com/' + repository + '/releases/download/v1.2.3/'
                    def download(url, _limit):
                        if url.startswith('https://api.github.com/repos/' + repository + '/'):
                            return json.dumps({'tag_name': 'v1.2.3', 'assets': [{'name': name, 'browser_download_url': base + name, 'digest': 'sha256:' + digest}]}).encode()
                        self.assertEqual(url, base + name)
                        return content
                    with patch.object(remote, 'native_download', side_effect=download):
                        self.assertEqual(remote.release_binary(component, '1.2.3', arch), executable)

    def test_binary_update_preserves_owner_mode_service_state_and_neighbor_files(self):
        for active in (False, True):
            with self.subTest(active=active), tempfile.TemporaryDirectory(prefix='homelab-native-fixture-') as temporary:
                binary = Path(temporary).resolve() / 'exporter'
                binary.write_bytes(b'old'); binary.chmod(0o755)
                neighbor = binary.parent / 'config'; neighbor.write_text('private configuration')
                before = binary.stat()
                calls = []
                def run(args, **_options):
                    calls.append(args)
                    if '--property=ActiveState' in args: return 'active' if active else 'inactive'
                    if args == ['/usr/bin/uname', '-m']: return 'x86_64'
                    if args[-1] == '--version': return version_output('node-exporter', '1.2.3' if Path(args[0]).read_bytes() == b'old' else '1.3.0')
                    return ''
                recipe = {'application':'node-exporter','binary':str(binary),'service':'exporter.service'}
                with patch.object(remote, 'release_binary', return_value=b'new'):
                    self.assertEqual(remote.binary_install(recipe,'1.2.3','1.3.0',run,lambda _:None,remote.atomic_content,remote.locked_directory),active)
                after = binary.stat()
                self.assertEqual((before.st_uid,before.st_gid,before.st_mode),(after.st_uid,after.st_gid,after.st_mode))
                self.assertEqual(sum('restart' in call for call in calls), int(active))
                self.assertEqual(neighbor.read_text(),'private configuration')
                self.assertEqual(set(binary.parent.iterdir()), {binary, neighbor})

    def test_wrong_archive_digest_never_reaches_an_executable(self):
        metadata = {'tag_name':'v1.2.3','assets':[{'name':'alloy-linux-amd64.zip','browser_download_url':'https://github.com/grafana/alloy/releases/download/v1.2.3/alloy-linux-amd64.zip','digest':'sha256:'+'a'*64}]}
        with patch.object(remote,'native_download',side_effect=[json.dumps(metadata).encode(),b'not trusted']), self.assertRaisesRegex(RuntimeError,'integrity'):
            remote.release_binary('alloy','1.2.3','amd64')

    def test_codex_uses_owner_exact_npm_package_without_retained_cache(self):
        with tempfile.TemporaryDirectory(prefix='homelab-codex-fixture-') as temporary:
            prefix = Path(temporary).resolve()
            manifest = prefix / 'lib/node_modules/@openai/codex/package.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'name':'@openai/codex','version':'1.2.3'}))
            owner = pwd.getpwuid(os.getuid()).pw_name
            recipe={'prefix':str(prefix),'user':owner,'node':'/fixture/node','npm':'/fixture/npm-cli.js'}
            calls=[]
            def run(args, **_options):
                calls.append(args)
                if 'install' in args:
                    manifest.write_text(json.dumps({'name':'@openai/codex','version':'1.3.0'}))
                    return ''
                return 'codex-cli ' + json.loads(manifest.read_text())['version']
            self.assertFalse(remote.codex_install(recipe,'1.2.3','1.3.0',run,lambda _:None,remote.locked_directory))
            install=next(args for args in calls if 'install' in args)
            self.assertEqual(install[:5],['/usr/sbin/runuser','-u',owner,'--','/fixture/node'])
            self.assertIn('@openai/codex@1.3.0',install)
            self.assertIn('--ignore-scripts',install)
            self.assertFalse(list(prefix.glob('.homelab-*')))

    def test_python_update_verifies_wheel_keeps_dependencies_and_preserves_service_state(self):
        for active in (False, True):
            with self.subTest(active=active), tempfile.TemporaryDirectory(prefix='homelab-python-fixture-') as temporary:
                directory=Path(temporary).resolve()
                recipe={'application':'pve-exporter','directory':str(directory),'service':'pve-exporter.service'}
                installed='1.2.3'; calls=[]; wheel=b'fixture-wheel'
                name='prometheus_pve_exporter-1.3.0-py3-none-any.whl'
                metadata={'info':{'name':'prometheus-pve-exporter','version':'1.3.0'},'urls':[{'filename':name,'url':'https://files.pythonhosted.org/packages/'+name,'digests':{'sha256':hashlib.sha256(wheel).hexdigest()}}]}
                def run(args, **_options):
                    nonlocal installed
                    calls.append(args)
                    if '--property=ActiveState' in args: return 'active' if active else 'inactive'
                    if '-c' in args: return installed
                    if '--dry-run' in args: return json.dumps({'install':[{'metadata':{'name':'prometheus-pve-exporter','version':'1.3.0'}}]})
                    if 'install' in args:
                        self.assertIn('--no-deps',args); self.assertIn('--no-index',args)
                        self.assertEqual(Path(args[-1]).read_bytes(),wheel); installed='1.3.0'
                    return ''
                with patch.object(remote,'native_download',side_effect=[json.dumps(metadata).encode(),wheel]):
                    self.assertEqual(remote.python_application_install(recipe,'1.2.3','1.3.0',run,lambda _:None,remote.locked_directory),active)
                self.assertEqual(sum('restart' in call for call in calls),int(active))
                self.assertTrue(any('check' in call for call in calls))
                self.assertFalse(list(directory.iterdir()))

    def test_python_dependency_changes_are_rejected_before_install(self):
        with tempfile.TemporaryDirectory(prefix='homelab-python-fixture-') as temporary:
            wheel=b'fixture'; name='prometheus_pve_exporter-1.3.0-py3-none-any.whl'
            metadata={'info':{'name':'prometheus-pve-exporter','version':'1.3.0'},'urls':[{'filename':name,'url':'https://files.pythonhosted.org/'+name,'digests':{'sha256':hashlib.sha256(wheel).hexdigest()}}]}
            calls=[]
            def run(args, **_options):
                calls.append(args)
                if '-c' in args: return '1.2.3'
                if '--property=ActiveState' in args: return 'active'
                if '--dry-run' in args: return json.dumps({'install':[{'metadata':{'name':'unexpected-dependency','version':'1.3.0'}}]})
                self.fail('Unexpected mutating command')
            with patch.object(remote,'native_download',side_effect=[json.dumps(metadata).encode(),wheel]), self.assertRaisesRegex(RuntimeError,'dependencies'):
                remote.python_application_install({'directory':str(Path(temporary).resolve()),'service':'pve-exporter.service'},'1.2.3','1.3.0',run,lambda _:None,remote.locked_directory)
            self.assertFalse(list(Path(temporary).iterdir()))

    def test_binary_metadata_change_during_download_is_rejected_before_replacement(self):
        with tempfile.TemporaryDirectory(prefix='homelab-native-fixture-') as temporary:
            binary=Path(temporary).resolve()/'exporter'; binary.write_bytes(b'old'); binary.chmod(0o755)
            def run(args, **_options):
                if '--property=ActiveState' in args: return 'inactive'
                if '-m' in args: return 'x86_64'
                return version_output('node-exporter','1.2.3' if args[0]==str(binary) else '1.3.0')
            def download(*_args): binary.chmod(0o750); return b'new'
            with patch.object(remote,'release_binary',side_effect=download), self.assertRaisesRegex(RuntimeError,'changed during preparation'):
                remote.binary_install({'application':'node-exporter','binary':str(binary),'service':'exporter.service'},'1.2.3','1.3.0',run,lambda _:None,remote.atomic_content,remote.locked_directory)
            self.assertEqual(binary.read_bytes(),b'old')
            self.assertEqual(list(binary.parent.iterdir()),[binary])


if __name__ == '__main__': unittest.main()
