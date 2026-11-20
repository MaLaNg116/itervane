import unittest
from io import BytesIO
from uuid import UUID

from guest_job import ProtocolError
from native_source import maintainer_source
from source_gateway import SourceRejected
from source_wire import CLOSED, RECEIPT, SOURCE_READY, START, SourceWire


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
