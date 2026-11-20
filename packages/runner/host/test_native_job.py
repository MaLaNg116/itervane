import hashlib
import io
import unittest
import uuid
from unittest.mock import patch

import guest_job as wire
import native_job as host


class FakeStream:
    def __init__(self, *frames):
        self.incoming = io.BytesIO(b"".join(wire.FRAME.pack(*frame) for frame in frames))
        self.outgoing = io.BytesIO()

    def send(self, data):
        return self.outgoing.write(data[:4096])

    def recv(self, size):
        return self.incoming.read(min(size, 16))


class NativeJobTest(unittest.TestCase):
    def setUp(self):
        self.run_id = uuid.uuid4()
        self.body = b"\x07" * host.INPUT_BYTES
        self.digest = hashlib.sha256(self.body).digest()
        self.prefix = (wire.STARTED, self.run_id.bytes, wire.CHUNK_BYTES, hashlib.sha256(self.body[:wire.CHUNK_BYTES]).digest())

    def exchange(self, runner, stream, after_prefix=lambda: None):
        with patch.object(host.secrets, "token_bytes", return_value=self.body):
            return runner.exchange(stream, str(self.run_id), lambda: None, after_prefix)

    def test_requires_a_prefix_receipt_from_this_run_before_sending_the_rest(self):
        replayed = (wire.STARTED, uuid.uuid4().bytes, *self.prefix[2:])
        stream = FakeStream(replayed)
        runner = host.ProbeJob("job")
        with self.assertRaisesRegex(wire.ProtocolError, "prefix receipt"):
            self.exchange(runner, stream)
        self.assertEqual(stream.outgoing.getvalue()[wire.FRAME.size:], self.body[:wire.CHUNK_BYTES])
        self.assertIsNone(runner.evidence)

    def test_requires_the_actual_terminal_digest_and_records_the_mismatch(self):
        inconsistent = FakeStream(self.prefix, (wire.VERIFIED, self.run_id.bytes, len(self.body), b"\0" * 32))
        with self.assertRaisesRegex(wire.ProtocolError, "terminal receipt"):
            self.exchange(host.ProbeJob("job"), inconsistent)

        modified = self.body[:-1] + b"\x06"
        actual = hashlib.sha256(modified).digest()
        stream = FakeStream(self.prefix, (wire.REJECTED, self.run_id.bytes, len(self.body), actual))
        runner = host.ProbeJob("job-reject-input")
        self.assertEqual(self.exchange(runner, stream), "job_input_rejected")
        self.assertEqual(stream.outgoing.getvalue()[wire.FRAME.size:], modified)
        self.assertEqual(runner.evidence.inputSha256, self.digest.hex())
        self.assertEqual(runner.evidence.receivedSha256, actual.hex())

    def test_fault_scenarios_do_not_deliver_the_remainder(self):
        for scenario in ("job-cancel", "job-timeout"):
            with self.subTest(scenario=scenario):
                stream = FakeStream(self.prefix, (wire.VERIFIED, self.run_id.bytes, len(self.body), self.digest))
                runner = host.ProbeJob(scenario)
                with self.assertRaisesRegex(wire.ProtocolError, "terminal receipt before body transfer"):
                    self.exchange(runner, stream)
                self.assertEqual(stream.outgoing.getvalue()[wire.FRAME.size:], self.body[:wire.CHUNK_BYTES])
                self.assertIsNone(runner.evidence.receivedSha256)
