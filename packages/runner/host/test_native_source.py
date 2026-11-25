import hashlib
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from uuid import UUID

from guest_job import ProtocolError
from native_source import RuleSamplesProbe, SourceProbe, maintainer_source
from oci_artifacts import ArtifactStore
from source_gateway import SourceRejected
from source_wire import CLOSED, MAX_RULE_VALIDATION_PROOF, OCI_ARCHIVE_FORMAT, QUALIFIED_START, RECEIPT, RULE_SAMPLES_START, START, SourceWire


RUN = "06d5d64c-664b-4c02-9bcc-48cec79e7696"


def no_deadline():
    pass


class VerifiedRelay:
    def __init__(self, gateway):
        self.commit = gateway.commit
        self.origin = gateway.origin
        self.fetched = False
        self.requests = 0
        self.transferred = 0
        self.closed = False
        self.denials = 0

    def request(self, kind, _body, check_deadline):
        check_deadline()
        if self.closed:
            self.denials += 1
            raise SourceRejected("source-closed")
        self.fetched = self.fetched or kind == b"P"
        self.requests += 1
        self.transferred += 1
        return b"o"

    def close(self):
        self.closed = True


class SourceExchangeTest(unittest.TestCase):
    def setUp(self):
        self.probe = maintainer_source()
        self.relay = VerifiedRelay(self.probe.gateway)
        self.probe.gateway = self.relay
        self.identity = UUID(RUN).bytes
        self.commit = bytes.fromhex(self.relay.commit)
        self.acquire_and_close = [(b"I", b""), (b"P", b"validated fetch"), (b"D", b""), (b"I", b"")]

    def exchange(self, frames):
        incoming, outgoing = BytesIO(), BytesIO()
        guest = SourceWire(outgoing.read, incoming.write, no_deadline)
        guest.greeting()
        for kind, payload in frames:
            guest.send(kind, payload)
        incoming.seek(0)
        host = SourceWire(incoming.read, outgoing.write, no_deadline)
        result = self.probe.exchange(host, RUN)
        outgoing.seek(0)
        return result, guest

    def test_success_requires_finish_and_denial_before_receipt(self):
        proof = RECEIPT.pack(self.identity, self.commit, b"t" * 20, b"d" * 32, 2)
        code, guest = self.exchange([*self.acquire_and_close, (b"M", proof)])
        self.assertEqual(code, "source_passed")
        self.assertEqual(guest.receive({b"S": START.size})[1], START.pack(self.identity, self.commit))
        for expected in (b"o", b"o", b""):
            self.assertEqual(guest.receive({b"O": 1})[1], expected)
        self.assertEqual(guest.receive({b"X": len(CLOSED)})[1], CLOSED)
        self.assertTrue(self.relay.closed)
        self.assertEqual((self.relay.requests, self.relay.denials), (2, 1))
        self.assertEqual(self.probe.evidence.commit, self.commit.hex())

    def test_early_receipt_or_wrong_run_cannot_produce_evidence(self):
        proof = RECEIPT.pack(b"r" * 16, self.commit, b"t" * 20, b"d" * 32, 2)
        for frames in ([(b"D", b"")], [*self.acquire_and_close, (b"M", proof)]):
            with self.subTest(frames=len(frames)), self.assertRaises(ProtocolError):
                self.exchange(frames)
            self.assertIsNone(self.probe.evidence)

    def test_rule_samples_use_a_distinct_frame_and_bind_the_guest_to_the_command(self):
        command = b'{"version":1}'
        proof = {"commandSha256": hashlib.sha256(command).hexdigest()}
        self.probe = RuleSamplesProbe(command)
        code, guest = self.exchange([(b"Z", json.dumps({"domainId": RUN, "proof": proof}).encode())])
        self.assertEqual(code, "rule_samples_recorded")
        self.assertEqual(guest.receive({b"T": RULE_SAMPLES_START.size})[1], RULE_SAMPLES_START.pack(self.identity))
        self.assertEqual(guest.receive({b"W": len(command)})[1], command)
        self.assertEqual(self.probe.proof, proof)
        for payload in (
            json.dumps({"domainId": "replaced", "proof": proof}).encode(),
            json.dumps({"domainId": RUN, "proof": {"commandSha256": "changed"}}).encode(),
            b"x" * (MAX_RULE_VALIDATION_PROOF + 1),
        ):
            self.probe = RuleSamplesProbe(command)
            with self.assertRaises(ProtocolError):
                self.exchange([(b"Z", payload)])
            self.assertIsNone(self.probe.proof)

    def test_scan_receipt_must_match_the_acquired_objects_and_run(self):
        self.probe.inspect = True
        proof = RECEIPT.pack(self.identity, self.commit, b"t" * 20, b"d" * 32, 2)
        inconsistent = json.dumps({"runId": RUN, "commit": "b" * 40, "tree": (b"t" * 20).hex(), "files": 2}).encode()
        with self.assertRaisesRegex(ProtocolError, "invalid inspection identity"):
            self.exchange([*self.acquire_and_close, (b"M", proof), (b"N", inconsistent)])
        self.assertIsNone(self.probe.inspection)

    def test_repair_payload_follows_egress_denial_and_fixed_object_proof(self):
        command = b"{}"
        self.probe = SourceProbe(self.relay, repository_id=RUN, repair_command=command)
        objects = RECEIPT.pack(self.identity, self.commit, b"t" * 20, b"d" * 32, 2)
        proof = {"runId": RUN, "repositoryId": RUN, "commit": self.commit.hex(), "tree": (b"t" * 20).hex(), "files": 2,
                 "commandSha256": hashlib.sha256(command).hexdigest()}
        code, guest = self.exchange([*self.acquire_and_close, (b"M", objects), (b"H", json.dumps(proof).encode())])
        self.assertEqual(code, "repair_passed")
        self.assertEqual(guest.receive({b"R": QUALIFIED_START.size})[1], QUALIFIED_START.pack(self.identity, self.commit, self.identity))
        for expected in (b"o", b"o", b""):
            self.assertEqual(guest.receive({b"O": 1})[1], expected)
        self.assertEqual(guest.receive({b"X": len(CLOSED)})[1], CLOSED)
        self.assertEqual(guest.receive({b"W": len(command)})[1], command)
        self.assertEqual(self.probe.repair, proof)

    def test_repair_observation_starts_a_distinct_read_only_job(self):
        command = b"{}"
        self.probe = SourceProbe(self.relay, repository_id=RUN, repair_command=command, repair_observation=True)
        objects = RECEIPT.pack(self.identity, self.commit, b"t" * 20, b"d" * 32, 2)
        proof = {"runId": RUN, "repositoryId": RUN, "commit": self.commit.hex(), "tree": (b"t" * 20).hex(), "files": 2,
                 "commandSha256": hashlib.sha256(command).hexdigest(), "observation": {}}
        code, guest = self.exchange([*self.acquire_and_close, (b"M", objects), (b"H", json.dumps(proof).encode())])
        self.assertEqual(code, "repair_passed")
        self.assertEqual(guest.receive({b"L": QUALIFIED_START.size})[1], QUALIFIED_START.pack(self.identity, self.commit, self.identity))
        self.assertEqual(self.probe.repair, proof)

    def test_verified_archive_chunks_remain_pending_until_controller_retains_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = ArtifactStore(root)
            command = b"{}"
            self.probe = SourceProbe(self.relay, repository_id=RUN, verification_command=command, artifact_store=store)
            payload = b"OCI fixture data"
            isolated = RECEIPT.pack(self.identity, self.commit, b"t" * 20, b"d" * 32, 2)
            descriptor = {"format": OCI_ARCHIVE_FORMAT, "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}
            proof = {"runId": RUN, "repositoryId": RUN, "commit": self.commit.hex(), "tree": (b"t" * 20).hex(), "files": 2,
                     "commandSha256": hashlib.sha256(command).hexdigest(), "build": {"baseline": {
                         "status": "passed", "appExited": True, "image": {"status": "scanned", "archive": descriptor},
                     }}}
            frames = [*self.acquire_and_close, (b"M", isolated), (b"Y", json.dumps(proof).encode())]
            code, _ = self.exchange([*frames, (b"J", payload[:8]), (b"J", payload[8:]), (b"Q", b"")])
            self.assertEqual(code, "inspection_passed")
            self.assertEqual(self.probe.inspection, proof)
            self.assertEqual(list(root.glob("*.oci.tar")), [])
            self.assertIsNotNone(self.probe.pending_archive)
            store.retain(self.probe.pending_archive)
            self.assertEqual((root / (descriptor["sha256"] + ".oci.tar")).read_bytes(), payload)

    def test_artifact_transfer_requires_explicit_scope_and_complete_framing(self):
        descriptor = {"format": OCI_ARCHIVE_FORMAT, "sha256": hashlib.sha256(b"ab").hexdigest(), "bytes": 2}
        proof = {"build": {"baseline": {"status": "passed", "appExited": True,
                                        "image": {"status": "scanned", "archive": descriptor}}}}
        data = BytesIO()
        guest = SourceWire(data.read, data.write, no_deadline)
        guest.send(b"J", b"a")
        guest.send(b"Q")
        data.seek(0)
        with self.assertRaisesRegex(ProtocolError, "unexpected OCI archive"):
            self.probe.receive_image_archive(guest, proof)
        with tempfile.TemporaryDirectory() as directory:
            store = ArtifactStore(directory)
            self.probe = SourceProbe(self.relay, repository_id=RUN, verification_command=b"{}", artifact_store=store)
            with self.assertRaisesRegex(ProtocolError, "invalid OCI archive transfer"):
                self.probe.receive_image_archive(guest, proof)
            self.assertIsNone(self.probe.pending_archive)
            self.assertEqual(list(Path(directory).iterdir()), [])
