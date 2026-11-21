import gzip
import hashlib
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path

from materialize_oci import materialize
from oci_guest import archive_image
from oci_layout import CONFIG, LAYER, MANIFEST, verify_layout


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


class OciLayoutTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.layout = Path(temporary.name)
        self.blobs = self.layout / "blobs/sha256"
        self.blobs.mkdir(parents=True)
        (self.layout / "oci-layout").write_bytes(encoded({"imageLayoutVersion": "1.0.0"}))
        layer = b"fixture layer bytes"
        self.layer = self.blob(LAYER, gzip.compress(layer, mtime=0))
        self.config = {
            "architecture": "amd64", "os": "linux",
            "rootfs": {"type": "layers", "diff_ids": ["sha256:" + hashlib.sha256(layer).hexdigest()]},
        }
        self.manifest = self.write_image()

    def blob(self, media, contents):
        digest = hashlib.sha256(contents).hexdigest()
        (self.blobs / digest).write_bytes(contents)
        return {"mediaType": media, "digest": "sha256:" + digest, "size": len(contents)}

    def write_image(self):
        config = self.blob(CONFIG, encoded(self.config))
        manifest = self.blob(MANIFEST, encoded({
            "schemaVersion": 2, "mediaType": MANIFEST, "config": config, "layers": [self.layer],
        }))
        (self.layout / "index.json").write_bytes(encoded({"schemaVersion": 2, "manifests": [manifest]}))
        return manifest

    def test_returns_verified_descriptors_and_platform(self):
        image = verify_layout(self.layout, self.manifest["digest"])
        self.assertEqual(image.manifest_digest, self.manifest["digest"])
        self.assertEqual(image.layer_digests, (self.layer["digest"],))
        self.assertEqual(image.config, self.config)

    def test_rejects_substituted_manifest_even_with_valid_blobs(self):
        self.config["config"] = {"User": "1:1"}
        self.write_image()
        with self.assertRaisesRegex(ValueError, "frozen image"):
            verify_layout(self.layout, self.manifest["digest"])

    def test_rejects_tampered_blob_with_the_same_size(self):
        path = self.blobs / self.layer["digest"][7:]
        original = path.read_bytes()
        path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            verify_layout(self.layout)

    def test_rejects_symbolic_links_and_hard_links(self):
        path = self.blobs / self.layer["digest"][7:]
        other = self.layout / "another"
        path.rename(other)
        path.symlink_to(other)
        with self.assertRaises(OSError):
            verify_layout(self.layout)
        path.unlink()
        os.link(other, path)
        with self.assertRaisesRegex(ValueError, "invalid OCI file"):
            verify_layout(self.layout)

    def test_rejects_remote_blob_descriptors(self):
        self.layer["urls"] = ["https://example.invalid/blob"]
        self.write_image()
        with self.assertRaisesRegex(ValueError, "invalid OCI descriptor"):
            verify_layout(self.layout)

    def test_rejects_other_platforms(self):
        self.config["architecture"] = "arm64"
        self.write_image()
        with self.assertRaisesRegex(ValueError, "invalid OCI platform"):
            verify_layout(self.layout)

    def test_materializes_the_qualified_archive_and_verifies_the_frozen_coordinates(self):
        image = verify_layout(self.layout)
        archive = self.layout / "qualified.oci.tar"
        descriptor = archive_image(self.layout, archive, image)
        staged = self.layout / "release"
        evidence = materialize(archive, staged, descriptor, image.manifest_digest, image.config_digest)
        self.assertEqual(evidence, {"manifestDigest": image.manifest_digest, "configDigest": image.config_digest})
        self.assertEqual(verify_layout(staged), image)

        with self.assertRaisesRegex(ValueError, "frozen descriptor"):
            materialize(archive, self.layout / "wrong-file", {**descriptor, "sha256": "0" * 64},
                        image.manifest_digest, image.config_digest)
        self.assertFalse((self.layout / "wrong-file").exists())
        with self.assertRaisesRegex(ValueError, "approved image"):
            materialize(archive, self.layout / "wrong-config", descriptor, image.manifest_digest, "sha256:" + "0" * 64)

    def test_materializer_refuses_noncanonical_members_even_with_matching_archive_digest(self):
        image = verify_layout(self.layout)
        for index, name in enumerate(["../escaped", "index.json", "blobs/sha256/" + "0" * 64]):
            archive = self.layout / f"invalid-{index}.oci.tar"
            descriptor = archive_image(self.layout, archive, image)
            archive.chmod(0o600)
            with tarfile.open(archive, "a") as output:
                entry = tarfile.TarInfo(name)
                if index == 2:
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "../outside"
                    output.addfile(entry)
                else:
                    entry.size = 1
                    output.addfile(entry, io.BytesIO(b"x"))
            with archive.open("rb") as file:
                modified = {**descriptor, "bytes": archive.stat().st_size, "sha256": hashlib.file_digest(file, "sha256").hexdigest()}
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "unexpected OCI archive entry"):
                materialize(archive, self.layout / f"blocked-{index}", modified, image.manifest_digest, image.config_digest)
        self.assertFalse((self.layout / "escaped").exists())
