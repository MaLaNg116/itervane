import hashlib
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from oci_artifacts import ArtifactStore
from source_wire import OCI_ARCHIVE_FORMAT


class OciArtifactStoreTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.store = ArtifactStore(self.root)
        self.payload = b"test OCI layout bytes"
        self.descriptor = {"format": OCI_ARCHIVE_FORMAT, "bytes": len(self.payload), "sha256": hashlib.sha256(self.payload).hexdigest()}

    def test_stages_and_retains_once_across_concurrent_calls(self):
        stages = [self.store.stage(self.descriptor, (self.payload[:6], self.payload[6:])) for _ in range(2)]
        self.assertEqual(len(list(self.root.glob(".pending-*"))), 2)
        self.assertEqual(list(self.root.glob("*.oci.tar")), [])
        with ThreadPoolExecutor(max_workers=2) as pool:
            receipts = list(pool.map(self.store.retain, stages))
        [archive] = list(self.root.glob("*.oci.tar"))
        self.assertEqual(receipts[0], receipts[1])
        self.assertEqual(archive.read_bytes(), self.payload)
        self.assertEqual(list(self.root.glob(".pending-*")), [])

    def test_partial_corrupt_and_oversize_transfers_are_discarded(self):
        for body in (self.payload[:-1], b"x" + self.payload[1:], self.payload + b"x", b""):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.store.stage(self.descriptor, (body,))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_aborted_stream_and_explicit_discard_leave_no_archive(self):
        def interrupted():
            yield self.payload[:6]
            raise TimeoutError()

        with self.assertRaises(TimeoutError):
            self.store.stage(self.descriptor, interrupted())
        stage = self.store.stage(self.descriptor, (self.payload,))
        self.store.discard(stage)
        self.store.discard(stage)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_corrupt_existing_archive_is_not_overwritten(self):
        corrupt = self.root / (self.descriptor["sha256"] + ".oci.tar")
        corrupt.write_bytes(b"x" + self.payload[1:])
        corrupt.chmod(0o400)
        stage = self.store.stage(self.descriptor, (self.payload,))
        with self.assertRaisesRegex(ValueError, "differs from receipt"):
            self.store.retain(stage)
        self.store.discard(stage)
        self.assertEqual(corrupt.read_bytes(), b"x" + self.payload[1:])
