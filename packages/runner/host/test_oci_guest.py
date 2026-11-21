import tarfile
import tempfile
import unittest
from pathlib import Path

from oci_guest import APP_DIR, pack_runtime


class OciGuestTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        self.project = self.workspace / "project"
        self.project.mkdir()
        self.node = self.workspace / "node"
        self.node.write_bytes(b"trusted test node bytes")
        for name, content in {
            "package.json": b"{}",
            "dist/index.html": b"<!DOCTYPE html>",
            "server/index.mjs": b"export {};",
            "node_modules/example/package.json": b'{"name":"example"}',
            "node_modules/example/empty": b"",
            "package-lock.json": b"non-runtime lock metadata",
        }.items():
            target = self.project / name
            target.parent.mkdir(exist_ok=True, parents=True)
            target.write_bytes(content)

    def test_repeats_the_same_layer_and_includes_only_required_paths(self):
        first, second = self.workspace / "first.tar", self.workspace / "second.tar"
        pack_runtime(self.project, first, self.node)
        pack_runtime(self.project, second, self.node)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as archive:
            files = {entry.name: entry for entry in archive.getmembers() if entry.isfile()}
            self.assertEqual(set(files), {"opt/itervane/bin/node", *(APP_DIR + "/" + name for name in (
                "package.json", "dist/index.html", "server/index.mjs",
                "node_modules/example/package.json", "node_modules/example/empty",
            ))})
            self.assertTrue(all(entry.uid == 0 and entry.gid == 0 for entry in files.values()))
            self.assertEqual(files["opt/itervane/bin/node"].mode, 0o555)
            self.assertEqual(archive.extractfile(APP_DIR + "/dist/index.html").read(), b"<!DOCTYPE html>")

    def test_rejects_symlinks_and_oci_whiteout_names(self):
        link = self.project / "server/extra"
        link.symlink_to(self.node)
        with self.assertRaises(OSError):
            pack_runtime(self.project, self.workspace / "link.tar", self.node)
        link.unlink()
        (self.project / "server/.wh.index.mjs").write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "unsupported runtime path"):
            pack_runtime(self.project, self.workspace / "whiteout.tar", self.node)
