"""Synthetic runtime distributions; no network, services or real toolchains are modified."""
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from test_update_execution import remote


def runtime_fixture(application, version):
    """Produce the official directory layout with inert, identifiable executable bytes."""
    stem = ('bun-linux-x64-baseline' if application == 'bun' else
            'node-v' + version + '-linux-x64' if application == 'node' else
            'gh_' + version + '_linux_amd64')
    name = stem + ('.zip' if application == 'bun' else '.tar.xz' if application == 'node' else '.tar.gz')
    member = stem + '/bun' if application == 'bun' else stem + '/bin/gh' if application == 'github-cli' else None
    stream = io.BytesIO()
    if application == 'bun':
        with zipfile.ZipFile(stream, 'w') as archive:
            archive.writestr(member, b'\x7fELF' + version.encode())
    else:
        with tarfile.open(fileobj=stream, mode='w:xz' if application == 'node' else 'w:gz') as archive:
            files = {'bin/node': b'\x7fELF' + version.encode(), 'lib/node_modules/npm/bin/npm-cli.js': b'// npm', 'lib/node_modules/npm/bin/npx-cli.js': b'// npx'} if application == 'node' else {'bin/gh': b'\x7fELF' + version.encode()}
            for path, content in files.items():
                entry = tarfile.TarInfo(stem + '/' + path); entry.size = len(content); entry.mode = 0o755
                archive.addfile(entry, io.BytesIO(content))
            if application == 'node':
                for link in ('npm', 'npx'):
                    entry = tarfile.TarInfo(stem + '/bin/' + link)
                    entry.type = tarfile.SYMTYPE; entry.linkname = '../lib/node_modules/npm/bin/' + link + '-cli.js'
                    archive.addfile(entry)
    content = stream.getvalue()
    return content, name, stem, member, hashlib.sha256(content).hexdigest()


class ToolchainTests(unittest.TestCase):
    """Keep project pins immutable while explicitly switching only shared defaults."""

    def test_two_upgrades_preserve_pins_and_handle_node_package_manager_symlinks(self):
        for application in ('bun', 'node', 'github-cli'):
            with self.subTest(application=application), tempfile.TemporaryDirectory(prefix='homelab-runtime-fixture-') as temporary:
                root = Path(temporary).resolve()
                directory = root / 'runtimes'; directory.mkdir(); directory.chmod(0o755)
                entrypoints = root / 'bin'; entrypoints.mkdir(); entrypoints.chmod(0o755)
                original = directory / '1.2.3'; original.mkdir()
                artifact = runtime_fixture(application, '1.2.3')
                remote.extract_runtime(*artifact[:4], original)
                member = 'bin/node' if application == 'node' else 'gh' if application == 'github-cli' else 'bun'
                pinned = original / member
                inventory = root / 'inventory.json'
                inventory.write_text(json.dumps({'executables': {application: str(pinned)}, 'unrelated': {'unchanged': True}}))
                inventory.chmod(0o644)
                recipe = {'application': application, 'directory': str(directory), 'inventory': str(inventory), 'links': []}
                wrapper = entrypoints / 'gh'
                if application == 'github-cli':
                    wrapper.write_text('#!/bin/sh\nexec ' + str(pinned) + ' "$@"\n'); wrapper.chmod(0o755)
                    recipe['wrapper'] = str(wrapper)
                else:
                    members = ['bin/node', 'bin/npm', 'bin/npx'] if application == 'node' else ['bun']
                    for index, part in enumerate(members):
                        link = entrypoints / Path(part).name
                        if index == 0: link.symlink_to(original / part)
                        recipe['links'].append({'path': str(link), 'member': part})
                def run(args, **_options):
                    if args == ['/usr/bin/uname', '-m']: return 'x86_64'
                    self.assertEqual(args[-1], '--version')
                    return Path(args[0]).read_bytes()[4:].decode()
                for before, after in [('1.2.3', '1.3.0'), ('1.3.0', '1.4.0')]:
                    with patch.object(remote, 'runtime_archive', return_value=runtime_fixture(application, after)):
                        self.assertFalse(remote.toolchain_install(recipe, before, after, run, lambda _: None, remote.atomic_content, remote.locked_directory))
                    self.assertEqual(json.loads(inventory.read_text())['executables'][application], str(directory / after / member))
                    self.assertTrue(json.loads(inventory.read_text())['unrelated']['unchanged'])
                    self.assertEqual(pinned.read_bytes(), b'\x7fELF1.2.3')
                    for link in recipe['links']:
                        self.assertEqual(Path(link['path']).resolve(), (directory / after / link['member']).resolve())
                    self.assertFalse(list(root.rglob('.homelab-runtime-*')))
                if application == 'github-cli':
                    self.assertIn(str(directory / '1.4.0/gh'), wrapper.read_text())
                    self.assertEqual(wrapper.stat().st_mode & 0o777, 0o755)

    def test_inventory_failure_restores_only_owned_default_links(self):
        with tempfile.TemporaryDirectory(prefix='homelab-runtime-fixture-') as temporary:
            root = Path(temporary).resolve(); original = root / '1.2.3'; original.mkdir()
            pinned = original / 'bun'; pinned.write_bytes(b'\x7fELF1.2.3')
            default = root / 'bun'; default.symlink_to(pinned)
            inventory = root / 'inventory.json'; inventory.write_text(json.dumps({'executables': {'bun': str(pinned)}}))
            inventory.chmod(0o644)
            recipe = {'application':'bun','directory':str(root),'inventory':str(inventory),'links':[{'path':str(default),'member':'bun'}]}
            def run(args, **_options): return 'x86_64' if args[-1] == '-m' else Path(args[0]).read_bytes()[4:].decode()
            with patch.object(remote, 'runtime_archive', return_value=runtime_fixture('bun', '1.3.0')):
                with self.assertRaisesRegex(RuntimeError, 'synthetic write failure'):
                    remote.toolchain_install(recipe, '1.2.3', '1.3.0', run, lambda _:None, lambda *_: (_ for _ in ()).throw(RuntimeError('synthetic write failure')), remote.locked_directory)
            self.assertEqual(default.resolve(), pinned)
            self.assertEqual(json.loads(inventory.read_text())['executables']['bun'], str(pinned))
            self.assertEqual(pinned.read_bytes(), b'\x7fELF1.2.3')

    def test_runtime_release_origin_digest_and_exact_version_are_verified(self):
        for application in ('bun', 'node', 'github-cli'):
            artifact = runtime_fixture(application, '1.3.0')
            content, name, _stem, _member, digest = artifact
            tag = 'bun-v1.3.0' if application == 'bun' else 'v1.3.0'
            repository = 'oven-sh/bun' if application == 'bun' else 'cli/cli'
            base = 'https://nodejs.org/dist/v1.3.0/' if application == 'node' else 'https://github.com/' + repository + '/releases/download/' + tag + '/'
            def download(url, _limit):
                if url.endswith('SHASUMS256.txt'): return (digest + '  ' + name).encode()
                if url.startswith('https://api.github.com/'):
                    return json.dumps({'tag_name':tag,'assets':[{'name':name,'browser_download_url':base+name,'digest':'sha256:'+digest}]}).encode()
                self.assertEqual(url,base+name); return content
            with self.subTest(application=application), patch.object(remote, 'native_download', side_effect=download):
                self.assertEqual(remote.runtime_archive(application,'1.3.0','x86_64'),artifact)
            with patch.object(remote, 'native_download', side_effect=[('0'*64+'  '+name).encode(),content] if application=='node' else [json.dumps({'tag_name':tag,'assets':[{'name':name,'browser_download_url':base+name,'digest':'sha256:'+'0'*64}]}).encode(),content]):
                with self.assertRaisesRegex(RuntimeError, 'integrity'):
                    remote.runtime_archive(application,'1.3.0','x86_64')

    def test_node_archives_cannot_escape_or_follow_indirect_parents(self):
        for mode in ('traversal', 'absolute-link', 'relative-link', 'indirect-parent', 'hardlink', 'special-mode'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix='homelab-runtime-fixture-') as temporary:
                stream=io.BytesIO()
                with tarfile.open(fileobj=stream,mode='w:xz') as archive:
                    entry=tarfile.TarInfo('node/bin/tool'); entry.size=1; entry.mode=0o755
                    if mode=='traversal': entry.name='node/../outside'
                    if mode in ('absolute-link','relative-link'):
                        entry.type=tarfile.SYMTYPE; entry.linkname='/etc/passwd' if mode=='absolute-link' else '../../outside'; entry.size=0
                    if mode=='hardlink': entry.type=tarfile.LNKTYPE; entry.linkname='node/bin/node'; entry.size=0
                    if mode=='special-mode': entry.mode=0o4755
                    if mode=='indirect-parent':
                        parent=tarfile.TarInfo('node/bin'); parent.type=tarfile.SYMTYPE; parent.linkname='lib'
                        archive.addfile(parent)
                    archive.addfile(entry,io.BytesIO(b'x') if entry.isfile() else None)
                with self.assertRaises(RuntimeError):
                    remote.extract_runtime(stream.getvalue(),'node.tar.xz','node',None,Path(temporary).resolve())


if __name__ == '__main__': unittest.main()
