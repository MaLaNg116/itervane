"""Run a single bounded verification job over a local KVM channel."""

import hashlib
import secrets
import sys
import time
import uuid
from dataclasses import dataclass, replace
from threading import Thread

from guest_job import (
    CHUNK_BYTES, FRAME, PORT, READY, REJECTED, REQUEST, STARTED, VERIFIED, WORKLOAD_READY,
    ProtocolError, read_exact, write_all,
)


SCENARIOS = ("heartbeat", "job", "job-reject-input", "job-cancel", "job-timeout")
INPUT_BYTES = 1024 * 1024
JOB_DEADLINE_SECONDS = 30
TIMEOUT_FIXTURE_SECONDS = 3
PREFIX_EVENT = "itervane-job-input-started"


class JobRejected(Exception):
    pass


@dataclass(frozen=True)
class JobEvidence:
    byteCount: int
    startedBytes: int
    inputSha256: str
    receivedSha256: str | None = None
    workloadVerified: bool = False


def stream_io(operation, argument):
    result = operation(argument)
    if result == -2:
        raise BlockingIOError()
    return result


def start_channel_events(libvirt):
    # The remote driver needs async socket processing for nonblocking
    # streams. This driver process serves one probe and owns the event loop.
    libvirt.virEventRegisterDefaultImpl()

    def dispatch():
        try:
            while True:
                libvirt.virEventRunDefaultImpl()
        except libvirt.libvirtError:
            return

    Thread(target=dispatch, name="libvirt-events", daemon=True).start()


class ProbeJob:
    def __init__(self, scenario, require_workload=False):
        self.scenario = scenario
        self.greetings = (WORKLOAD_READY,) if require_workload else (READY, WORKLOAD_READY)
        self.evidence = None
        self.phase = "open-channel"

    def exchange(self, stream, run_id, check_deadline, after_prefix):
        identity = uuid.UUID(run_id).bytes
        payload = secrets.token_bytes(INPUT_BYTES)
        expected = hashlib.sha256(payload).digest()
        if self.scenario == "job-reject-input":
            payload = payload[:-1] + bytes([payload[-1] ^ 1])

        def send(body):
            write_all(lambda chunk: stream_io(stream.send, chunk), body, check_deadline)

        def receive(size):
            return read_exact(lambda remaining: stream_io(stream.recv, remaining), size, check_deadline)

        self.phase = "guest-ready"
        greeting = receive(len(READY))
        if greeting not in self.greetings:
            raise ProtocolError("unexpected guest greeting")

        self.phase = "prefix"
        prefix = payload[:CHUNK_BYTES]
        send(FRAME.pack(REQUEST, identity, len(payload), expected))
        send(prefix)
        if FRAME.unpack(receive(FRAME.size)) != (STARTED, identity, len(prefix), hashlib.sha256(prefix).digest()):
            raise ProtocolError("unexpected prefix receipt")
        check_deadline()
        self.evidence = JobEvidence(len(payload), len(prefix), expected.hex(), workloadVerified=greeting == WORKLOAD_READY)
        after_prefix()

        self.phase = "result"
        if self.scenario not in ("job-cancel", "job-timeout"):
            send(payload[len(prefix):])
        actual = hashlib.sha256(payload).digest()
        outcome = VERIFIED if expected == actual else REJECTED
        if FRAME.unpack(receive(FRAME.size)) != (outcome, identity, len(payload), actual):
            raise ProtocolError("unexpected terminal receipt")
        check_deadline()
        if self.scenario in ("job-cancel", "job-timeout"):
            raise ProtocolError("terminal receipt before body transfer")
        self.evidence = replace(self.evidence, receivedSha256=actual.hex())
        return "job_passed" if outcome == VERIFIED else "job_input_rejected"

    def run(self, libvirt, conn, domain, run_id, check_lifecycle):
        deadline = time.monotonic() + JOB_DEADLINE_SECONDS

        def check_deadline():
            check_lifecycle()
            if time.monotonic() >= deadline:
                raise JobRejected("job_deadline_exceeded")

        def after_prefix():
            nonlocal deadline
            if self.scenario == "job-cancel":
                # The verification parent sends SIGTERM only after this receipt.
                print(PREFIX_EVENT, file=sys.stderr, flush=True)
            if self.scenario == "job-timeout":
                deadline = min(deadline, time.monotonic() + TIMEOUT_FIXTURE_SECONDS)

        try:
            check_deadline()
            stream = conn.newStream(libvirt.VIR_STREAM_NONBLOCK)
            domain.openChannel(PORT, stream, 0)
            try:
                return self.exchange(stream, run_id, check_deadline, after_prefix)
            finally:
                try:
                    stream.abort()
                except libvirt.libvirtError:
                    # The lifecycle confirms the domain's removal independently.
                    pass
        except libvirt.libvirtError as error:
            raise JobRejected("job_channel_unavailable") from error
        except ProtocolError as error:
            raise JobRejected("job_protocol_rejected") from error
