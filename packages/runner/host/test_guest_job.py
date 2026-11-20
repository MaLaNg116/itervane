import hashlib
import io
import unittest
import uuid

import guest_job as job


class GuestJobTest(unittest.TestCase):
    def setUp(self):
        self.run_id = uuid.uuid4().bytes
        self.body = bytes(range(256)) * (job.CHUNK_BYTES // 256 + 2)
        self.digest = hashlib.sha256(self.body).digest()

    def request(self, frame=job.REQUEST, size=None, digest=None):
        return job.FRAME.pack(frame, self.run_id, len(self.body) if size is None else size, digest or self.digest)

    def serve(self, incoming):
        source = io.BytesIO(incoming)
        sink = io.BytesIO()
        job.serve_job(lambda size: source.read(min(size, 512)), lambda body: sink.write(body[:9]), lambda: None)
        greeting, receipts = sink.getvalue()[:len(job.READY)], sink.getvalue()[len(job.READY):]
        self.assertEqual(greeting, job.READY)
        return list(job.FRAME.iter_unpack(receipts))

    def test_hashes_fragmented_input_and_proves_the_prefix_before_the_full_result(self):
        self.assertEqual(self.serve(self.request() + self.body), [
            (job.STARTED, self.run_id, job.CHUNK_BYTES, hashlib.sha256(self.body[:job.CHUNK_BYTES]).digest()),
            (job.VERIFIED, self.run_id, len(self.body), self.digest),
        ])

    def test_mismatched_digest_never_returns_verified(self):
        frames = self.serve(self.request(digest=b"\x00" * 32) + self.body)
        self.assertEqual(frames[1], (job.REJECTED, self.run_id, len(self.body), self.digest))

    def test_rejects_wrong_version_and_payload_sizes_before_reading_the_body(self):
        for header in (self.request(frame=b"ITJ2"), self.request(size=0), self.request(size=job.MAX_INPUT_BYTES + 1)):
            with self.subTest(header=header), self.assertRaisesRegex(job.ProtocolError, "invalid request header"):
                self.serve(header)

    def test_truncation_after_the_prefix_cannot_create_a_terminal_receipt(self):
        source = io.BytesIO(self.request() + self.body[:-1])
        sink = io.BytesIO()
        with self.assertRaisesRegex(job.ProtocolError, "truncated"):
            job.serve_job(source.read, sink.write, lambda: None)
        self.assertEqual(list(job.FRAME.iter_unpack(sink.getvalue()[len(job.READY):])), [
            (job.STARTED, self.run_id, job.CHUNK_BYTES, hashlib.sha256(self.body[:job.CHUNK_BYTES]).digest()),
        ])


if __name__ == "__main__":
    unittest.main()
