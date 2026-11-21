"""Native source acquisition through an isolated guest's named port."""

import hashlib
import json
import time
import uuid
from dataclasses import dataclass

from guest_job import ProtocolError
from native_job import JobRejected, open_channel, stream_io
from source_gateway import RegisteredOrigin, SourceGateway, SourceRejected
from source_wire import (
    CLOSED, GUEST_ERRORS, GUEST_REPAIR_ERRORS, MAX_FILES, MAX_INSPECTION_RECEIPT, MAX_QUALIFIED_RECEIPT,
    MAX_REPAIR_COMMAND, MAX_REPAIR_RECEIPT, MAX_REQUEST_BYTES, MAX_VERIFICATION_COMMAND, MAX_VERIFICATION_RECEIPT,
    QUALIFIED_START, RECEIPT, SOURCE_PORT, START, SourceWire,
)


ACQUISITION_SECONDS = 65
INSPECTION_SECONDS = 90
# This probe selects an owner-authorized public repository at an immutable ref.
PROBE_SOURCE = "https://github.com/MaLaNg116/itervane.git"
PROBE_COMMIT = "a9276df7269444caeb61724ba490bf0387c4e3aa"
INSPECTION_COMMIT = "9167604c888416d7b6518e1c76485d7308cffb5c"


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

    def __init__(self, gateway, inspect=False, repository_id=None, repair_command=None, repair_observation=False,
                 verification_command=None):
        if repair_command is not None and (repository_id is None or not 0 < len(repair_command) <= MAX_REPAIR_COMMAND):
            raise ValueError("invalid repair command")
        if repair_observation and repair_command is None:
            raise ValueError("missing repair observation command")
        if verification_command is not None and (repository_id is None or repair_command is not None
            or not 0 < len(verification_command) <= MAX_VERIFICATION_COMMAND):
            raise ValueError("invalid verification command")
        self.gateway = gateway
        self.evidence = None
        self.inspect = inspect or repository_id is not None
        self.repository_id = repository_id
        self.repair_command = repair_command
        self.repair_observation = repair_observation
        self.verification_command = verification_command
        self.inspection = None
        self.repair = None
        self.scan_deadline = None
        self.phase = "source-open"

    def receive(self, wire, limits):
        kind, payload = wire.receive({**limits, b"E": 24})
        if kind == b"E":
            if payload not in GUEST_ERRORS and not (self.phase == "repair-results" and payload in GUEST_REPAIR_ERRORS):
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
        if self.repository_id is None:
            wire.send(b"A" if self.inspect else b"S", START.pack(identity, commit))
        else:
            start = (b"V" if self.verification_command is not None else b"L" if self.repair_observation
                     else b"R" if self.repair_command is not None else b"F")
            wire.send(start, QUALIFIED_START.pack(identity, commit, uuid.UUID(self.repository_id).bytes))
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
        if self.verification_command is not None:
            self.phase = "verification-results"
            self.scan_deadline = time.monotonic() + INSPECTION_SECONDS
            wire.send(b"W", self.verification_command)
            proof = self.read_proof(wire, run_id, b"Y", MAX_VERIFICATION_RECEIPT)
            if proof.get("commandSha256") != hashlib.sha256(self.verification_command).hexdigest():
                raise ProtocolError("invalid verification command digest")
            self.inspection = proof
            return "inspection_passed"
        if self.repair_command is not None:
            self.phase = "repair-results"
            self.scan_deadline = time.monotonic() + INSPECTION_SECONDS
            wire.send(b"W", self.repair_command)
            repair = self.read_proof(wire, run_id, b"H", MAX_REPAIR_RECEIPT)
            if repair.get("commandSha256") != hashlib.sha256(self.repair_command).hexdigest():
                raise ProtocolError("invalid repair command digest")
            self.repair = repair
            return "repair_passed"
        if not self.inspect:
            return "source_passed"
        self.phase = "scan-results"
        self.scan_deadline = time.monotonic() + INSPECTION_SECONDS
        size = MAX_QUALIFIED_RECEIPT if self.repository_id is not None else MAX_INSPECTION_RECEIPT
        self.inspection = self.read_proof(wire, run_id, b"N", size)
        return "inspection_passed"

    def read_proof(self, wire, run_id, frame, size):
        _, response = self.receive(wire, {frame: size})
        try:
            inspection = json.loads(response)
        except (ValueError, RecursionError) as error:
            raise ProtocolError("invalid inspection receipt") from error
        if (
            not isinstance(inspection, dict) or inspection.get("runId") != run_id
            or inspection.get("commit") != self.evidence.commit or inspection.get("tree") != self.evidence.tree
            or inspection.get("files") != self.evidence.files
            or inspection.get("repositoryId") != self.repository_id
        ):
            raise ProtocolError("invalid inspection identity")
        wire.check_deadline()
        return inspection

    def run(self, libvirt, conn, domain, run_id, check_lifecycle):
        deadline = time.monotonic() + ACQUISITION_SECONDS

        def check_deadline():
            check_lifecycle()
            if time.monotonic() >= (self.scan_deadline or deadline):
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


def maintainer_source(inspect=False):
    origin = RegisteredOrigin.parse(PROBE_SOURCE, {"github.com"})
    commit = INSPECTION_COMMIT if inspect else PROBE_COMMIT
    return SourceProbe(SourceGateway(origin, commit), inspect)
