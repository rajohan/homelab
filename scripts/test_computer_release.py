"""Qualify passive artifact identity and immutable publication without GitHub access."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from publishComputerRelease import file_digest, publish, qualified_assets


class ComputerReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mira-release-publish-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.tag, self.revision = "v0.10.0", "a" * 40
        self.archive = self.root / "mira-computer-0.10.0-windows-x64.zip"
        self.manifest = self.archive.with_suffix(".json")
        self.installer = self.root / "mira-computer-0.10.0-windows-x64-setup.exe"
        self.installer.write_bytes(b"qualified synthetic installer bytes")
        self.archive.write_bytes(b"qualified synthetic archive bytes")
        self.metadata = {"schemaVersion": 1, "platform": "windows-x64", "version": "0.10.0", "revision": self.revision,
                         "archive": {"name": self.archive.name, "size": self.archive.stat().st_size, "sha256": file_digest(self.archive)},
                         "installer": {"name": self.installer.name, "size": self.installer.stat().st_size, "sha256": file_digest(self.installer)}}
        self.manifest.write_text(json.dumps(self.metadata), encoding="utf-8")
        self.release = {"tagName": self.tag, "isDraft": False, "isPrerelease": False, "assets": []}

    def test_rejects_mismatch_and_additional_artifacts(self):
        self.assertEqual(qualified_assets(self.root, self.tag, self.revision), (self.archive, self.manifest, self.installer))
        for tag, revision in [("v0.10.0-rc.1", self.revision), (self.tag, "main"), (self.tag, "b" * 40)]:
            with self.assertRaises(ValueError):
                qualified_assets(self.root, tag, revision)
        self.archive.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "digest"):
            qualified_assets(self.root, self.tag, self.revision)
        (self.root / "extra.exe").write_bytes(b"extra")
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            qualified_assets(self.root, self.tag, self.revision)

    def test_publishes_only_missing_files_without_clobber(self):
        with patch("publishComputerRelease.subprocess.check_output", return_value=json.dumps(self.release)), patch("publishComputerRelease.subprocess.run") as run:
            publish(self.root, self.tag, self.revision)
            run.assert_called_once_with(["gh", "release", "upload", self.tag, str(self.archive), str(self.manifest), str(self.installer)], check=True)

    def test_retry_verifies_all_existing_bytes_before_upload(self):
        self.release["assets"] = [{"name": self.archive.name}]

        def download(command, **_):
            self.assertEqual(command[:4], ["gh", "release", "download", self.tag])
            (Path(command[-1]) / self.archive.name).write_bytes(b"different bytes")

        with patch("publishComputerRelease.subprocess.check_output", return_value=json.dumps(self.release)), patch("publishComputerRelease.subprocess.run", side_effect=download) as run:
            with self.assertRaisesRegex(ValueError, "refusing replacement"):
                publish(self.root, self.tag, self.revision)
            self.assertEqual(run.call_count, 1)

    def test_identical_retry_does_not_republish(self):
        self.release["assets"] = [{"name": asset.name} for asset in (self.archive, self.manifest, self.installer)]

        def download(command, **_):
            self.assertEqual(command[:4], ["gh", "release", "download", self.tag])
            name = command[5]
            (Path(command[-1]) / name).write_bytes((self.root / name).read_bytes())

        with patch("publishComputerRelease.subprocess.check_output", return_value=json.dumps(self.release)), patch("publishComputerRelease.subprocess.run", side_effect=download) as run:
            publish(self.root, self.tag, self.revision)
            self.assertEqual(run.call_count, 3)

    def test_missing_or_changed_installer_cannot_publish(self):
        self.installer.write_bytes(b"different installer")
        with self.assertRaisesRegex(ValueError, "installer digest"):
            qualified_assets(self.root, self.tag, self.revision)
        self.installer.unlink()
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            qualified_assets(self.root, self.tag, self.revision)

    def test_draft_and_prerelease_never_publish(self):
        for field in ["isDraft", "isPrerelease"]:
            with patch("publishComputerRelease.subprocess.check_output", return_value=json.dumps({**self.release, field: True})), patch("publishComputerRelease.subprocess.run") as run:
                with self.assertRaises(ValueError):
                    publish(self.root, self.tag, self.revision)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
