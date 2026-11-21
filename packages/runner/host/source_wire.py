"""Bounded frames for a single guest Git acquisition."""

import struct

from guest_job import ProtocolError, read_exact, write_all


SOURCE_PORT = "org.itervane.runner.source.0"
SOURCE_READY = b"ITG1"
FRAME = struct.Struct("!cI")
START = struct.Struct("!16s20s")
QUALIFIED_START = struct.Struct("!16s20s16s")
RECEIPT = struct.Struct("!16s20s20s32sH")
MAX_REQUEST_BYTES = 65536
MAX_TRANSFER_BYTES = 32 * 1024 * 1024
MAX_FILES = 5000
MAX_INSPECTION_RECEIPT = 2048
MAX_QUALIFIED_RECEIPT = 4 * 1024 * 1024
MAX_REPAIR_COMMAND = 2 * 1024 * 1024
MAX_REPAIR_RECEIPT = 16 * 1024
MAX_VERIFICATION_COMMAND = MAX_REPAIR_COMMAND + 8192
MAX_VERIFICATION_RECEIPT = 8 * 1024 * 1024
MAX_OCI_ARCHIVE_BYTES = 200 * 1024 * 1024
MAX_OCI_CHUNK_BYTES = 512 * 1024
OCI_ARCHIVE_FORMAT = "oci-layout-tar"
REFS_TYPE = "application/x-git-upload-pack-advertisement"
PACK_TYPE = "application/x-git-upload-pack-result"
UPLOAD_TYPE = "application/x-git-upload-pack-request"
CLOSED = b"source-closed"
GUEST_ERRORS = frozenset((
    b"guest-input", b"git-fetch", b"git-objects", b"guest-io",
    b"snapshot-rejected", b"scan-boundary", b"scan-inputs", b"scan-gitleaks",
    b"scan-trivy", b"scan-controls", b"scan-integrity",
))
GUEST_REPAIR_ERRORS = frozenset((
    b"repair-base", b"repair-scope", b"repair-precondition", b"repair-invalid", b"repair-integrity",
))


class SourceWire:
    def __init__(self, read, write, check_deadline):
        self.read = read
        self.write = write
        self.check_deadline = check_deadline

    def greeting(self):
        write_all(self.write, SOURCE_READY, self.check_deadline)

    def expect_greeting(self):
        if read_exact(self.read, len(SOURCE_READY), self.check_deadline) != SOURCE_READY:
            raise ProtocolError("unexpected source greeting")

    def send(self, kind, payload=b""):
        write_all(self.write, FRAME.pack(kind, len(payload)), self.check_deadline)
        write_all(self.write, payload, self.check_deadline)

    def receive(self, limits):
        kind, size = FRAME.unpack(read_exact(self.read, FRAME.size, self.check_deadline))
        if kind not in limits or size > limits[kind]:
            raise ProtocolError("unexpected source frame or size")
        return kind, read_exact(self.read, size, self.check_deadline)
