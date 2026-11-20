"""Versioned single-job protocol shared by the native host and sealed guest."""

import hashlib
import os
import pwd
import stat
import struct
import time


PORT = "org.itervane.runner.job.0"
FRAME = struct.Struct("!4s16sI32s")
READY = b"ITR1"
WORKLOAD_READY = b"ITR2"
REQUEST = b"ITJ1"
STARTED = b"ITS1"
VERIFIED = b"ITV1"
REJECTED = b"ITE1"
CHUNK_BYTES = 64 * 1024
MAX_INPUT_BYTES = 32 * 1024**2
POLL_SECONDS = 0.025
GUEST_DEADLINE_SECONDS = 90
WORKLOAD_RECEIPT = "/run/itervane-probe-workload/ready"


class ProtocolError(Exception):
    pass


def read_exact(read, size, check_deadline):
    received = bytearray()
    while len(received) < size:
        check_deadline()
        try:
            block = read(size - len(received))
        except BlockingIOError:
            time.sleep(POLL_SECONDS)
            continue
        if not block:
            raise ProtocolError("truncated frame or body")
        received.extend(block)
    return bytes(received)


def write_all(write, body, check_deadline):
    offset = 0
    while offset < len(body):
        check_deadline()
        try:
            sent = write(body[offset:offset + CHUNK_BYTES])
        except BlockingIOError:
            time.sleep(POLL_SECONDS)
            continue
        if sent <= 0:
            raise ProtocolError("channel stopped accepting data")
        offset += sent


def serve_job(read, write, check_deadline, greeting=READY):
    write_all(write, greeting, check_deadline)
    version, run_id, size, expected = FRAME.unpack(read_exact(read, FRAME.size, check_deadline))
    if version != REQUEST or not 0 < size <= MAX_INPUT_BYTES:
        raise ProtocolError("invalid request header")

    prefix_size = min(size, CHUNK_BYTES)
    digest = hashlib.sha256(read_exact(read, prefix_size, check_deadline))
    write_all(write, FRAME.pack(STARTED, run_id, prefix_size, digest.digest()), check_deadline)
    remaining = size - prefix_size
    while remaining:
        block = read_exact(read, min(remaining, CHUNK_BYTES), check_deadline)
        digest.update(block)
        remaining -= len(block)

    observed = digest.digest()
    outcome = VERIFIED if observed == expected else REJECTED
    write_all(write, FRAME.pack(outcome, run_id, size, observed), check_deadline)


def verify_workload_receipt():
    owner = pwd.getpwnam("itervane-workload").pw_uid
    expected = b"itervane-workload-v1\n"
    fd = os.open(WORKLOAD_RECEIPT, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as receipt:
        metadata = os.fstat(receipt.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != owner or receipt.read(len(expected) + 1) != expected:
            raise ProtocolError("workload receipt unavailable")


def main():
    if os.geteuid() == 0:
        return 1
    deadline = time.monotonic() + GUEST_DEADLINE_SECONDS

    def check_deadline():
        if time.monotonic() >= deadline:
            raise ProtocolError("guest deadline exceeded")

    try:
        verify_workload_receipt()
        port = os.open(f"/dev/virtio-ports/{PORT}", os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
        try:
            serve_job(lambda size: os.read(port, size), lambda body: os.write(port, body), check_deadline, WORKLOAD_READY)
        finally:
            os.close(port)
    except (KeyError, OSError, ProtocolError):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
