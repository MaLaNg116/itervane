"""Local, single-job controller for the dedicated KVM account."""

import hashlib
import json
import os
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

from libvirt_probe import IMAGE_DIGEST, Rejected, Result, check_kvm, closed, connect, locked_workspace, probe, start_channel_events
from native_source import SourceProbe
from session_boundary import SESSION_URI, SessionRejected, prepare_session
from source_gateway import COMMIT, RegisteredOrigin, SourceGateway, SourceRejected
from source_wire import GUEST_REPAIR_ERRORS, MAX_REPAIR_COMMAND


REQUEST_LIMIT = 2048
RESPONSE_LIMIT = 4 * 1024 * 1024 + 8192
HANDSHAKE_SECONDS = 3
PULSE_SECONDS = 2
READY = b"READY 1\n"
STATUS = b"STATUS 1\n"
IDS = ("requestId", "taskId", "runId", "projectId", "repositoryId")
COUNTERS = ("generation", "fence")
FIELDS = {*IDS, *COUNTERS, "version", "planSha256", "workspaceSha256", "commit", "origin"}
REPAIR = "apply_repair"
OBSERVE_REPAIR = "observe_repair"
REPAIR_OPERATIONS = (REPAIR, OBSERVE_REPAIR)
REPAIR_DIGESTS = ("repairInputSha256", "baseSnapshotSha256", "commandSha256")
REPAIR_FIELDS = (FIELDS - {"planSha256"}) | {"operation", "operationId", "commandBytes", *REPAIR_DIGESTS}
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
    if not isinstance(data, dict):
        raise ValueError("invalid request fields")
    repair = data.get("operation") in REPAIR_OPERATIONS
    if data.keys() != (REPAIR_FIELDS if repair else FIELDS) or type(data["version"]) is not int or data["version"] != 1:
        raise ValueError("invalid request fields")
    if not all(is_v4(data[name]) for name in IDS) or (repair and not is_v4(data["operationId"])):
        raise ValueError("invalid request identity")
    if not all(type(data[name]) is int and 0 < data[name] <= 2147483647 for name in COUNTERS):
        raise ValueError("invalid request authority")
    digests = (*REPAIR_DIGESTS, "workspaceSha256") if repair else ("planSha256", "workspaceSha256")
    patterns = {name: IMAGE_DIGEST for name in digests}
    patterns["commit"] = COMMIT
    for name, pattern in patterns.items():
        if not isinstance(data[name], str) or not pattern.fullmatch(data[name]):
            raise ValueError("invalid fixed reference")
    if repair and (type(data["commandBytes"]) is not int or not 0 < data["commandBytes"] <= MAX_REPAIR_COMMAND):
        raise ValueError("invalid command size")
    if not isinstance(data["origin"], str) or not 0 < len(data["origin"]) <= 768:
        raise ValueError("invalid source")
    return data


def read_frame(connection):
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
    return bytes(line)


def read_command(connection, request):
    expires = time.monotonic() + HANDSHAKE_SECONDS
    size = request["commandBytes"]
    data = bytearray()
    while len(data) < size:
        remaining = expires - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        connection.settimeout(remaining)
        block = connection.recv(min(65536, size - len(data)))
        if not block:
            raise ValueError("truncated repair command")
        data.extend(block)
    if hashlib.sha256(data).hexdigest() != request["commandSha256"]:
        raise ValueError("repair command digest mismatch")
    command = json.loads(data, object_pairs_hook=unique_fields)
    field = "patch" if request["operation"] == REPAIR else "targets"
    if not isinstance(command, dict) or command.keys() != {"workspace", field}:
        raise ValueError("invalid repair command")
    workspace = command["workspace"]
    source = {"repositoryId": request["repositoryId"], "commit": request["commit"]}
    if (
        not isinstance(workspace, dict) or workspace.get("source") != source
        or any(workspace.get(field) != request[field] for field in ("operationId", "repairInputSha256", "baseSnapshotSha256"))
    ):
        raise ValueError("repair command authority mismatch")
    if field == "patch":
        patch = command["patch"]
        if not isinstance(patch, dict) or patch.get("baseSnapshotSha256") != request["baseSnapshotSha256"]:
            raise ValueError("repair command authority mismatch")
    else:
        targets = command["targets"]
        if not isinstance(targets, list) or not 0 < len(targets) <= 8:
            raise ValueError("invalid repair targets")
    return bytes(data)


def workspace_binding(root, metadata):
    boot = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
    if not is_v4(boot):
        raise Rejected("config_required")
    identity = f"{boot}:{metadata.st_uid}:{metadata.st_dev}:{metadata.st_ino}:{root}"
    return hashlib.sha256(os.fsencode(identity)).hexdigest()


def workspace_idle(libvirt, root, image, fingerprint):
    try:
        with locked_workspace(root) as metadata:
            if workspace_binding(root, metadata) != fingerprint or any(root.iterdir()):
                return False
            prepare_session(root, image)
            conn = connect(libvirt, SESSION_URI)
            try:
                idle = not conn.listAllDomains(0)
            finally:
                disconnected = closed(libvirt, conn)
            return idle and disconnected
    except (OSError, Rejected, SessionRejected, libvirt.libvirtError):
        return False


class LiveConnection:
    def __init__(self, connection, stopping):
        self.connection = connection
        self.stopping = stopping
        self.lost = Event()
        self.done = Event()
        self.thread = Thread(target=self.watch, name="runner-lease", daemon=True)
        self.connection.settimeout(PULSE_SECONDS)

    def watch(self):
        try:
            while not self.done.is_set():
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
        # Keep the read half open while the authorized client waits for the receipt.
        self.done.set()
        self.thread.join()


def rejected(code, request_id=None, cleanup="not_started", domain_id=None):
    return {"kind": "rejected", "requestId": request_id, "code": code, "cleanup": cleanup, "domainId": domain_id}


def response_for(request, result):
    request_id = request["requestId"]
    repair = request.get("operation") in REPAIR_OPERATIONS
    observation = request.get("operation") == OBSERVE_REPAIR
    expected_code = "repair_passed" if repair else "inspection_passed"
    snapshot = result.repair if repair else result.inspection
    if (
        result.code == expected_code and result.cleanupConfirmed and result.sessionVerified
        and result.runId and result.imageSha256 and result.source and isinstance(snapshot, dict) and snapshot
    ):
        evidence = snapshot.get("observation" if observation else "candidate") if repair else None
        if not repair or (
            snapshot.get("commandSha256") == request["commandSha256"] and isinstance(evidence, dict)
            and snapshot.get("manifestSha256") == evidence.get("baseSnapshotSha256") == request["baseSnapshotSha256"]
            and evidence.get("repairInputSha256") == request["repairInputSha256"] and evidence.get("operationId") == request["operationId"]
        ):
            kind = "repair_observation" if observation else "repair_receipt" if repair else "receipt"
            return {
                "kind": kind,
                "scope": {key: value for key, value in request.items() if key != "origin"},
                "domainId": result.runId, "imageSha256": result.imageSha256, "originSha256": result.source.originSha256,
                "commitSha256": result.source.commitSha256, "cleanupConfirmed": True, "sessionVerified": True,
                "snapshot": snapshot,
            }
    if result.code in ("pending_cleanup", "workspace_busy", "cleanup_unproven"):
        return rejected("cleanup_unproven", request_id, "unknown", result.runId)
    if result.cleanupConfirmed and result.sessionVerified:
        response = rejected("lease_lost" if result.code == "cancelled" else "job_failed", request_id, "confirmed", result.runId)
        if repair and response["code"] == "job_failed" and result.jobIssue and result.jobIssue.encode("ascii") in GUEST_REPAIR_ERRORS:
            response["issue"] = result.jobIssue
        return response
    if result.runId is not None:
        return rejected("cleanup_unproven", request_id, "unknown", result.runId)
    return rejected("not_ready", request_id)


def serve_connection(connection, worker_uid, origins, fingerprint, observe, launch, stopping, enable_repair=False):
    connection.settimeout(HANDSHAKE_SECONDS)
    _, uid, _ = PEER.unpack(connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, PEER.size))
    if uid != worker_uid:
        return rejected("peer_denied")
    try:
        frame = read_frame(connection)
        if frame == STATUS:
            return observe()
        request = parse_request(frame)
    except (OSError, ValueError, RecursionError):
        return rejected("invalid_request")
    repair = request.get("operation") in REPAIR_OPERATIONS
    if request["workspaceSha256"] != fingerprint or (repair and not enable_repair):
        return rejected("not_ready", request["requestId"])
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
    try:
        command = read_command(connection, request) if repair else None
    except (OSError, ValueError, RecursionError):
        return rejected("invalid_request", request["requestId"])
    if stopping():
        return rejected("lease_lost", request["requestId"])
    with LiveConnection(connection, stopping) as live:
        result = launch(request, origin, live.cancelled, command)
    return response_for(request, result)


def socket_parent(path):
    parent = path.parent
    if not path.is_absolute() or not path.name.endswith(".sock") or len(os.fsencode(path)) > 100 or parent.resolve(strict=True) != parent:
        raise ValueError("invalid socket path")
    metadata = parent.stat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise ValueError("invalid socket directory")


def run_server(path, worker_uid, origins, fingerprint, observe, launch, stopping, enable_repair):
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
                        result = serve_connection(connection, worker_uid, origins, fingerprint, observe, launch, stopping, enable_repair)
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
        enable_repair = allowed[:1] == ["--enable-repair"]
        if enable_repair:
            allowed = allowed[1:]
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
        with locked_workspace(root) as metadata:
            fingerprint = workspace_binding(root, metadata)
        import libvirt
        import libvirt_qemu
        libvirt.registerErrorHandler(lambda _ctx, _error: None, None)
        start_channel_events(libvirt)

        def observe():
            idle = not stopped() and workspace_idle(libvirt, root, image, fingerprint)
            return {"kind": "status", "version": 1, "workspaceSha256": fingerprint,
                    "imageSha256": digest, "state": "idle" if idle else "blocked"}

        def launch(request, origin, cancelled, command):
            if not workspace_idle(libvirt, root, image, fingerprint):
                return Result("pending_cleanup")
            job = SourceProbe(SourceGateway(origin, request["commit"]), repository_id=request["repositoryId"],
                              repair_command=command, repair_observation=request.get("operation") == OBSERVE_REPAIR)
            return probe(libvirt, libvirt_qemu, root, image, digest, cancelled, "inspect", True, source_override=job)

        run_server(path, worker_uid, origins, fingerprint, observe, launch, stopped, enable_repair)
    except (ImportError, OSError, ValueError, Rejected, SessionRejected, SourceRejected):
        print("Qualified inspection controller could not start.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
