import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from build_guest import canonical, directory_fd, measured_tree


class BuildOutputTest(unittest.TestCase):
    def test_dist_summary_hashes_the_sorted_entries_and_enforces_bounds(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root / "asset.js").write_bytes(b"bundle")
            (root / "index.html").write_bytes(b"page")
            entries = [{"path": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
                       for name, data in (("asset.js", b"bundle"), ("index.html", b"page"))]
            with directory_fd(root) as fd:
                expected = {"sha256": hashlib.sha256(canonical(entries)).hexdigest(), "files": 2, "bytes": 10}
                self.assertEqual(measured_tree(fd, 2, 10, 6, artifact=True), expected)
                with self.assertRaises(ValueError):
                    measured_tree(fd, 2, 9, 6, artifact=True)

    def test_dist_rejects_links_instead_of_reading_outside_output(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            (root / "index.html").write_bytes(b"page")
            link = root / "asset.js"
            for make_link in (os.symlink, os.link):
                make_link(root / "index.html", link)
                with directory_fd(root) as fd:
                    with self.assertRaises(ValueError):
                        measured_tree(fd, 2, 20, 10, artifact=True)
                link.unlink()

    def test_materialized_artifacts_match_the_hash_of_the_copied_bytes(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            source, target = root / "dist", root / "sealed"
            (source / "assets").mkdir(parents=True)
            (source / "index.html").write_bytes(b"page")
            (source / "assets" / "main.js").write_bytes(b"bundle")
            with directory_fd(source) as fd:
                expected = measured_tree(fd, 2, 10, 6, artifact=True, copy_into=target)
            with directory_fd(target) as fd:
                self.assertEqual(measured_tree(fd, 2, 10, 6, artifact=True), expected)
