"""Local, single-job inspection controller for the dedicated KVM account."""

import json
import os
import re
import signal
import socket
import stat
import struct
import sys
import time
import uuid
from pathlib import Path
from threading import Event, Thread
from urllib.parse import urlsplit

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from libvirt_probe import IMAGE_DIGEST, Rejected, check_kvm, probe, start_channel_events
from native_source import SourceProbe
from session_boundary import SessionRejected, prepare_session
from source_gateway import COMMIT, RegisteredOrigin, SourceGateway, SourceRejected


REQUEST_LIMIT = 2048
RESPONSE_LIMIT = 4 * 1024 * 1024 + 8192
HANDSHAKE_SECONDS = 3
PULSE_SECONDS = 2
READY = b"READY 1\n"
IDS = ("requestId", "taskId", "runId", "projectId", "repositoryId")
COUNTERS = ("generation", "fence")
FIELDS = {*IDS, *COUNTERS, "version", "planSha256", "commit", "origin"}
PEER = struct.Struct("3i")


def unique_fields(items):
    value = dict(items)
    if len(value) != len(items):
        raise ValueError("duplicate request field")
    return value


def is_v4(value):
    if not isinstance(value, str):
        return False
    try:
        identity = uuid.UUID(value)
    except ValueError:
        return False
    return identity.version == 4 and str(identity) == value


def parse_request(line):
    if len(line) > REQUEST_LIMIT or not line.endswith(b"\n"):
        raise ValueError("invalid request frame")
    data = json.loads(line, object_pairs_hook=unique_fields)
    if not isinstance(data, dict) or data.keys() != FIELDS or type(data["version"]) is not int or data["version"] != 1:
        raise ValueError("invalid request fields")
    if not all(is_v4(data[name]) for name in IDS):
        raise ValueError("invalid request identity")
    if not all(type(data[name]) is int and 0 < data[name] <= 2147483647 for name in COUNTERS):
        raise ValueError("invalid request authority")
    for name, pattern in (("planSha256", IMAGE_DIGEST), ("commit", COMMIT)):
        if not isinstance(data[name], str) or not pattern.fullmatch(data[name]):
            raise ValueError("invalid fixed reference")
    if not isinstance(data["origin"], str) or not 0 < len(data["origin"]) <= 768:
        raise ValueError("invalid source")
    return data


def read_request(connection):
    expires = time.monotonic() + HANDSHAKE_SECONDS
    line = bytearray()
    while len(line) <= REQUEST_LIMIT:
        remaining = expires - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        connection.settimeout(remaining)
        byte = connection.recv(1)
        if not byte:
            break
        line.extend(byte)
        if byte == b"\n":
            break
    return parse_request(line)


class LiveConnection:
    def __init__(self, connection, stopping):
        self.connection = connection
        self.stopping = stopping
        self.lost = Event()
        self.thread = Thread(target=self.watch, name="runner-lease", daemon=True)
        self.connection.settimeout(PULSE_SECONDS)

    def watch(self):
        try:
            while True:
                pulses = self.connection.recv(64)
                if not pulses or pulses.count(b"K") != len(pulses):
                    return
        except OSError:
            pass
        finally:
            self.lost.set()

    def cancelled(self):
        return self.stopping() or self.lost.is_set()

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        try:
            self.connection.shutdown(socket.SHUT_RD)
        except OSError:
            pass
        self.thread.join()


def rejected(code, request_id=None, cleanup="not_started", domain_id=None):
    return {"kind": "rejected", "requestId": request_id, "code": code, "cleanup": cleanup, "domainId": domain_id}


def response_for(request, result):
    request_id = request["requestId"]
    if (
        result.code == "inspection_passed" and result.cleanupConfirmed and result.sessionVerified
        and result.runId and result.imageSha256 and result.source and result.inspection
    ):
        return {
            "kind": "receipt", "scope": {key: value for key, value in request.items() if key != "origin"},
            "domainId": result.runId, "imageSha256": result.imageSha256, "originSha256": result.source.originSha256,
            "commitSha256": result.source.commitSha256, "cleanupConfirmed": True, "sessionVerified": True,
            "snapshot": result.inspection,
        }
    if result.code in ("pending_cleanup", "workspace_busy", "cleanup_unproven"):
        return rejected("cleanup_unproven", request_id, "unknown", result.runId)
    if result.cleanupConfirmed and result.sessionVerified:
        return rejected("lease_lost" if result.code == "cancelled" else "job_failed", request_id, "confirmed", result.runId)
    if result.runId is not None:
        return rejected("cleanup_unproven", request_id, "unknown", result.runId)
    return rejected("not_ready", request_id)


def serve_connection(connection, worker_uid, origins, launch, stopping):
    connection.settimeout(HANDSHAKE_SECONDS)
    _, uid, _ = PEER.unpack(connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, PEER.size))
    if uid != worker_uid:
        return rejected("peer_denied")
    try:
        request = read_request(connection)
    except (OSError, ValueError, RecursionError):
        return rejected("invalid_request")
    origin = origins.get(request["origin"])
    if origin is None:
        return rejected("origin_denied", request["requestId"])
    connection.settimeout(HANDSHAKE_SECONDS)
    connection.sendall(READY)
    try:
        first = connection.recv(1)
    except OSError:
        first = b""
    if first != b"K" or stopping():
        return rejected("lease_lost", request["requestId"])
    with LiveConnection(connection, stopping) as live:
        result = launch(request, origin, live.cancelled)
    return response_for(request, result)


def socket_parent(path):
    parent = path.parent
    if not path.is_absolute() or not path.name.endswith(".sock") or len(os.fsencode(path)) > 100 or parent.resolve(strict=True) != parent:
        raise ValueError("invalid socket path")
    metadata = parent.stat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise ValueError("invalid socket directory")


def run_server(path, worker_uid, origins, launch, stopping):
    socket_parent(path)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
        server.bind(os.fspath(path))
        inode = path.lstat().st_ino
        try:
            server.listen(2)
            server.settimeout(0.5)
            while not stopping():
                try:
                    connection, _ = server.accept()
                except TimeoutError:
                    continue
                with connection:
                    try:
                        result = serve_connection(connection, worker_uid, origins, launch, stopping)
                        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
                        if len(encoded) > RESPONSE_LIMIT:
                            encoded = b'{"kind":"rejected","requestId":null,"code":"cleanup_unproven","cleanup":"unknown","domainId":null}\n'
                        connection.settimeout(HANDSHAKE_SECONDS)
                        connection.sendall(encoded)
                    except OSError:
                        # Losing the peer cannot turn a lifecycle failure into a receipt.
                        continue
        finally:
            try:
                if path.lstat().st_ino == inode:
                    path.unlink()
            except FileNotFoundError:
                pass


def main():
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    def stopped():
        return stopping

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    os.umask(0o077)
    try:
        path, root, image = map(Path, sys.argv[1:4])
        digest, name = sys.argv[4:6]
        allowed = sys.argv[6:]
        worker_uid = int(name)
        if (
            not 0 < worker_uid < 2**31 or worker_uid == os.geteuid()
            or not IMAGE_DIGEST.fullmatch(digest) or not 1 <= len(allowed) <= 16
            or not root.is_absolute() or root.resolve(strict=True) != root or not image.is_absolute()
        ):
            raise ValueError("invalid runner configuration")
        origins = {value: RegisteredOrigin.parse(value, {urlsplit(value).hostname}) for value in allowed}
        check_kvm()
        prepare_session(root, image)
        import libvirt
        import libvirt_qemu
        libvirt.registerErrorHandler(lambda _ctx, _error: None, None)
        start_channel_events(libvirt)

        def launch(request, origin, cancelled):
            job = SourceProbe(SourceGateway(origin, request["commit"]), repository_id=request["repositoryId"])
            return probe(libvirt, libvirt_qemu, root, image, digest, cancelled, "inspect", True, source_override=job)

        run_server(path, worker_uid, origins, launch, stopped)
    except (ImportError, OSError, ValueError, Rejected, SessionRejected, SourceRejected):
        print("Qualified inspection controller could not start.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
