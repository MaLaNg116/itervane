"""Native source acquisition through an isolated guest's named port."""

import hashlib
import time
import uuid
from dataclasses import dataclass

from guest_job import ProtocolError
from native_job import JobRejected, open_channel, stream_io
from source_gateway import RegisteredOrigin, SourceGateway, SourceRejected
from source_wire import CLOSED, GUEST_ERRORS, MAX_FILES, MAX_REQUEST_BYTES, RECEIPT, SOURCE_PORT, START, SourceWire


ACQUISITION_SECONDS = 65
# This probe selects an owner-authorized public repository at an immutable ref.
PROBE_SOURCE = "https://github.com/MaLaNg116/itervane.git"
PROBE_COMMIT = "a9276df7269444caeb61724ba490bf0387c4e3aa"


@dataclass(frozen=True)
class SourceEvidence:
    originSha256: str
    commit: str
    tree: str
    commitSha256: str
    files: int
    requests: int
    transferredBytes: int


class SourceProbe:
    port = SOURCE_PORT

    def __init__(self, gateway):
        self.gateway = gateway
        self.evidence = None
        self.phase = "source-open"

    def receive(self, wire, limits):
        kind, payload = wire.receive({**limits, b"E": 24})
        if kind == b"E":
            if payload not in GUEST_ERRORS:
                raise ProtocolError("unexpected guest source failure")
            self.phase = payload.decode("ascii")
            raise JobRejected("source_guest_failed")
        return kind, payload

    def exchange(self, wire, run_id):
        gateway = self.gateway
        identity = uuid.UUID(run_id).bytes
        commit = bytes.fromhex(gateway.commit)
        self.phase = "source-ready"
        wire.expect_greeting()
        wire.send(b"S", START.pack(identity, commit))
        self.phase = "source-fetch"
        while True:
            kind, body = self.receive(wire, {b"I": 0, b"P": MAX_REQUEST_BYTES, b"D": 0})
            if kind == b"D":
                if not gateway.fetched:
                    raise ProtocolError("source retrieval did not complete")
                break
            wire.send(b"O", gateway.request(kind, body, wire.check_deadline))

        gateway.close()
        self.phase = "source-closed"
        wire.send(b"O")
        kind, body = self.receive(wire, {b"I": 0})
        try:
            gateway.request(kind, body, wire.check_deadline)
        except SourceRejected as error:
            if str(error).encode("ascii") != CLOSED:
                raise
        else:
            raise ProtocolError("closed source accepted another request")
        wire.send(b"X", CLOSED)

        self.phase = "source-objects"
        _, proof = self.receive(wire, {b"M": RECEIPT.size})
        if len(proof) != RECEIPT.size:
            raise ProtocolError("invalid source receipt size")
        returned, actual, tree, digest, count = RECEIPT.unpack(proof)
        if returned != identity or actual != commit or not 0 < count <= MAX_FILES:
            raise ProtocolError("invalid source receipt identity or size")
        wire.check_deadline()
        origin = f"https://{gateway.origin.host}{gateway.origin.path}".encode("ascii")
        self.evidence = SourceEvidence(
            hashlib.sha256(origin).hexdigest(), actual.hex(), tree.hex(), digest.hex(), count,
            gateway.requests, gateway.transferred,
        )
        return "source_passed"

    def run(self, libvirt, conn, domain, run_id, check_lifecycle):
        deadline = time.monotonic() + ACQUISITION_SECONDS

        def check_deadline():
            check_lifecycle()
            if time.monotonic() >= deadline:
                raise JobRejected("job_deadline_exceeded")

        try:
            check_deadline()
            with open_channel(libvirt, conn, domain, self.port) as stream:
                wire = SourceWire(lambda n: stream_io(stream.recv, n), lambda b: stream_io(stream.send, b), check_deadline)
                return self.exchange(wire, run_id)
        except SourceRejected as error:
            self.phase = str(error)
            raise JobRejected("source_rejected") from error
        except libvirt.libvirtError as error:
            raise JobRejected("job_channel_unavailable") from error
        except ProtocolError as error:
            raise JobRejected("job_protocol_rejected") from error
        finally:
            self.gateway.close()


def maintainer_source():
    origin = RegisteredOrigin.parse(PROBE_SOURCE, {"github.com"})
    return SourceProbe(SourceGateway(origin, PROBE_COMMIT))
