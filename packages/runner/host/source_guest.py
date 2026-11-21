"""Git acquisition in the sealed guest, using only a private loopback relay."""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory, TemporaryFile

# Isolated Python ignores its script directory. Only load our sealed modules.
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from guest_job import ProtocolError, verify_workload_receipt
from source_wire import (
    CLOSED, GUEST_ERRORS, GUEST_REPAIR_ERRORS, MAX_FILES, MAX_INSPECTION_RECEIPT, MAX_QUALIFIED_RECEIPT,
    MAX_REPAIR_COMMAND, MAX_REPAIR_RECEIPT, MAX_REQUEST_BYTES, MAX_TRANSFER_BYTES, MAX_VERIFICATION_COMMAND,
    MAX_VERIFICATION_RECEIPT, MAX_OCI_ARCHIVE_BYTES, MAX_OCI_CHUNK_BYTES, PACK_TYPE, QUALIFIED_START, RECEIPT,
    REFS_TYPE, SOURCE_PORT, START, UPLOAD_TYPE, SourceWire,
)


WORK = "/var/lib/itervane-probe-source"
INSPECTION_TOOLS = Path("/usr/local/libexec/itervane-inspection")
INSPECTION_REQUEST = Path("/var/lib/itervane-inspection-source/scan-request")
REPAIR_COMMAND = INSPECTION_REQUEST.with_name("repair-command.json")
REPAIR_OBSERVATION = INSPECTION_REQUEST.with_name("repair-observation.json")
VERIFICATION_COMMAND = INSPECTION_REQUEST.with_name("verification-command.json")
INSPECTION_RECEIPT = Path("/var/lib/itervane-inspection-output/receipt.json")
BUILD_INPUT = Path("/var/lib/itervane-build-input")
BUILD_RECEIPT = Path("/var/lib/itervane-build-output/receipt.json")
RUNTIME_RECEIPT = Path("/var/lib/itervane-runtime-output/receipt.json")
IMAGE_ARCHIVE = Path("/var/lib/itervane-image-output/image.oci.tar")
FIXTURE_REPOSITORY_ID = "a955164f-7cf2-45c5-8a53-7cdb556db805"
GIT_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"}


class GuestFailure(Exception):
    pass


class GitRequest(BaseHTTPRequestHandler):
    def log_message(self, *unused):
        pass

    def do_GET(self):
        if (self.path != "/source.git/info/refs?service=git-upload-pack" or "Transfer-Encoding" in self.headers
                or self.headers.get("Content-Length", "0") != "0"):
            self.send_error(400)
            return
        self.transfer(b"I", b"", REFS_TYPE)

    def do_POST(self):
        sizes = self.headers.get_all("Content-Length", [])
        if (self.path != "/source.git/git-upload-pack" or "Transfer-Encoding" in self.headers
                or self.headers.get_content_type() != UPLOAD_TYPE or len(sizes) != 1
                or not re.fullmatch(r"[0-9]{1,5}", sizes[0]) or not 0 < int(sizes[0]) <= MAX_REQUEST_BYTES):
            self.send_error(400)
            return
        size = int(sizes[0])
        body = self.rfile.read(size)
        if len(body) != size:
            self.send_error(400)
            return
        self.transfer(b"P", body, PACK_TYPE)

    def transfer(self, kind, body, media):
        self.server.wire.send(kind, body)
        _, payload = self.server.wire.receive({b"O": MAX_TRANSFER_BYTES})
        self.send_response(200)
        self.send_header("Content-Type", media)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class GitLoopback(HTTPServer):
    def __init__(self, wire):
        super().__init__(("127.0.0.1", 0), GitRequest)
        self.timeout = 0.1
        self.wire = wire
        self.failed = False

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def handle_error(self, request, address):
        self.failed = True


def git_command(root, *arguments):
    return [
        "/usr/bin/git", "-C", root, "--no-replace-objects",
        "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.http.allow=always",
        "-c", "protocol.version=0", "-c", "http.followRedirects=false", "-c", "http.maxRequests=1",
        "-c", "http.proxy=", "-c", "credential.helper=", "-c", "fetch.fsckObjects=true",
        "-c", "gc.auto=0", "-c", "maintenance.auto=false", *arguments,
    ]


def git_output(root, *arguments, limit=65536):
    with TemporaryFile(dir=root) as output:
        outcome = subprocess.run(
            git_command(root, *arguments), env=GIT_ENV, stdin=subprocess.DEVNULL, stdout=output,
            stderr=subprocess.DEVNULL, timeout=15, check=False,
        )
        output.seek(0)
        data = output.read(limit + 1)
    if outcome.returncode or len(data) > limit:
        raise GuestFailure("git-objects")
    return data


def acquire(root, wire, commit, check_deadline):
    git_output(root, "init", "--bare", "--quiet", "--template=", "--object-format=sha1")
    with GitLoopback(wire) as server:
        target = f"http://127.0.0.1:{server.server_port}/source.git"
        with subprocess.Popen(
            git_command(root, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", target, commit),
            env=GIT_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ) as child:
            try:
                while child.poll() is None:
                    check_deadline()
                    server.handle_request()
                    if server.failed:
                        raise GuestFailure("git-fetch")
                if child.returncode:
                    raise GuestFailure("git-fetch")
            finally:
                if child.poll() is None:
                    child.kill()


def verify_objects(root, identity, commit):
    observed = git_output(root, "rev-parse", "--verify", "FETCH_HEAD^{commit}", limit=128).strip()
    if observed != commit.encode("ascii"):
        raise GuestFailure("git-objects")
    git_output(root, "fsck", "--strict", "--no-reflogs", commit)
    raw_commit = git_output(root, "cat-file", "commit", commit)
    tree = git_output(root, "rev-parse", "--verify", commit + "^{tree}", limit=128).strip()
    if not re.fullmatch(b"[0-9a-f]{40}", tree) or not raw_commit.startswith(b"tree " + tree + b"\n"):
        raise GuestFailure("git-objects")
    body = b"commit " + str(len(raw_commit)).encode("ascii") + b"\0" + raw_commit
    if hashlib.sha1(body).hexdigest() != commit:
        raise GuestFailure("git-objects")
    records = git_output(root, "ls-tree", "-rz", "--full-tree", commit, limit=MAX_FILES * 600).split(b"\0")
    if records[-1] or not 0 < len(records) - 1 <= MAX_FILES:
        raise GuestFailure("git-objects")
    for record in records[:-1]:
        metadata, separator, name = record.partition(b"\t")
        if not separator or not 0 < len(name) <= 512 or not re.fullmatch(b"100(?:644|755) blob [0-9a-f]{40}", metadata):
            raise GuestFailure("git-objects")
    return RECEIPT.pack(identity, bytes.fromhex(commit), bytes.fromhex(tree.decode()), hashlib.sha256(raw_commit).digest(), len(records) - 1)


def wait_receipt(path, limit, wire):
    while True:
        wire.check_deadline()
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            time.sleep(0.1)
        else:
            break
    with os.fdopen(fd, "rb") as report:
        info = os.fstat(report.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise GuestFailure("scan-integrity")
        receipt = report.read(limit + 1)
    if len(receipt) > limit:
        raise GuestFailure("scan-integrity")
    return receipt


def read_inspection(receipt, command):
    try:
        proof = json.loads(receipt)
        if not isinstance(proof, dict):
            raise ValueError()
        if "code" in proof:
            code = proof["code"].encode("ascii")
            scan_failure = code.startswith((b"scan-", b"snapshot-")) and code in GUEST_ERRORS
            if len(proof) == 1 and (scan_failure or (command is not None and code in GUEST_REPAIR_ERRORS)):
                raise GuestFailure(code.decode("ascii"))
            raise ValueError()
    except (AttributeError, ValueError, RecursionError) as error:
        raise GuestFailure("scan-integrity") from error
    return proof


def observe_standard_baseline(build, profile, wire):
    names = ("runId", "verificationInputSha256", "subjectManifestSha256", "buildProfileSha256", "baselineSha256", "projectionSha256")
    request = {name: build[name] for name in names}
    request["distSha256"] = build["dist"]["sha256"]
    if "ociInputsSha256" in profile:
        request.update({name: profile[name] for name in ("ociInputsSha256", "scannerInputsSha256")})
        if profile.get("retainStandardImage") is True:
            request["retainStandardImage"] = True
    staged = BUILD_INPUT / "baseline-request.pending"
    with staged.open("xb") as output:
        output.write(json.dumps(request, separators=(",", ":")).encode("ascii"))
        os.fchmod(output.fileno(), 0o440)
    staged.rename(BUILD_INPUT / "baseline-request.json")
    try:
        limit = 2 * 1024**2 if "ociInputsSha256" in request else 8192
        published = json.loads(wait_receipt(RUNTIME_RECEIPT, limit, wire))
    except (ValueError, RecursionError) as error:
        raise GuestFailure("scan-integrity") from error
    if not isinstance(published, dict) or published.get("request") != request:
        raise GuestFailure("scan-integrity")
    baseline = published.get("result")
    if (not isinstance(baseline, dict) or baseline.get("baselineSha256") != request["baselineSha256"]
        or baseline.get("distSha256") != request["distSha256"]):
        raise GuestFailure("scan-integrity")
    return baseline


def with_standard_build(receipt, proof, command, wire):
    frozen = json.loads(command)
    profile = frozen["input"]["profile"]
    expected = profile.get("buildProfileSha256")
    if expected is None:
        return receipt
    staged = subprocess.run(
        [INSPECTION_TOOLS / "node", INSPECTION_TOOLS / "worker.mjs", "stage-standard-build"],
        env=GIT_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False,
    )
    if staged.returncode:
        raise GuestFailure("scan-integrity")
    blocked = BUILD_INPUT / "blocked.json"
    path = blocked if blocked.exists() else BUILD_RECEIPT
    try:
        outcome = json.loads(wait_receipt(path, 2048, wire))
    except (ValueError, RecursionError) as error:
        raise GuestFailure("scan-integrity") from error
    target = proof["target"]["manifestSha256"] if proof["target"] is not None else proof["manifestSha256"]
    if (not isinstance(outcome, dict) or outcome.get("buildProfileSha256") != expected
        or outcome.get("baselineSha256") != profile["baselineSha256"]
        or outcome.get("verificationInputSha256") != proof["verificationInputSha256"]
        or outcome.get("runId") != proof["runId"] or outcome.get("subjectManifestSha256") != target):
        raise GuestFailure("scan-integrity")
    if profile.get("runStandardBaseline") is True and outcome.get("status") == "built":
        outcome["baseline"] = observe_standard_baseline(outcome, profile, wire)
    proof["build"] = outcome
    serialized = json.dumps(proof, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(serialized) > MAX_VERIFICATION_RECEIPT:
        raise GuestFailure("scan-integrity")
    return serialized


def inspect_source(repository, identity, commit, repository_id, mode, wire, command=None):
    published = {
        "verification": (VERIFICATION_COMMAND, MAX_VERIFICATION_RECEIPT, b"Y"),
        "repair": (REPAIR_COMMAND, MAX_REPAIR_RECEIPT, b"H"),
        "repair-observation": (REPAIR_OBSERVATION, MAX_REPAIR_RECEIPT, b"H"),
        "qualified": (None, MAX_QUALIFIED_RECEIPT, b"N"),
        "fixture": (None, MAX_INSPECTION_RECEIPT, b"N"),
    }
    command_path, receipt_limit, receipt_frame = published[mode]
    if (command_path is None) != (command is None):
        raise GuestFailure("guest-input")
    command_written = False
    requested = False
    try:
        if command_path is not None:
            with command_path.open("xb") as stream:
                command_written = True
                stream.write(command)
                os.fchmod(stream.fileno(), 0o440)
        result = subprocess.run(
            [INSPECTION_TOOLS / "node", INSPECTION_TOOLS / "worker.mjs", "snapshot", repository,
             str(uuid.UUID(bytes=identity)), commit, repository_id, mode],
            env=GIT_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=35,
        )
        if result.returncode:
            raise GuestFailure("snapshot-rejected")
        INSPECTION_REQUEST.touch(mode=0o600, exist_ok=False)
        requested = True
        receipt = wait_receipt(INSPECTION_RECEIPT, receipt_limit, wire)
        proof = read_inspection(receipt, command)
        if mode == "verification":
            receipt = with_standard_build(receipt, proof, command, wire)
    finally:
        if requested:
            INSPECTION_REQUEST.unlink()
        if command_written:
            command_path.unlink()
    wire.send(receipt_frame, receipt)
    if mode == "verification":
        image = proof.get("build", {}).get("baseline", {}).get("image")
        if image and image.get("status") == "scanned" and "archive" in image:
            send_image_archive(wire, image["archive"])


def send_image_archive(wire, archive):
    requested = archive["bytes"]
    if type(requested) is not int or not 0 < requested <= MAX_OCI_ARCHIVE_BYTES:
        raise GuestFailure("scan-integrity")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(IMAGE_ARCHIVE, flags), "rb") as contents:
        info = os.fstat(contents.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != requested:
            raise GuestFailure("scan-integrity")
        remaining = requested
        while remaining:
            chunk = contents.read(min(remaining, MAX_OCI_CHUNK_BYTES))
            if not chunk:
                raise GuestFailure("scan-integrity")
            wire.send(b"J", chunk)
            remaining -= len(chunk)
        if contents.read(1):
            raise GuestFailure("scan-integrity")
    wire.send(b"Q")


def serve_source(wire, work):
    wire.greeting()
    scenario, start = wire.receive({b"S": START.size, b"A": START.size, b"F": QUALIFIED_START.size,
                                    b"R": QUALIFIED_START.size, b"L": QUALIFIED_START.size, b"V": QUALIFIED_START.size})
    if scenario in (b"F", b"R", b"L", b"V") and len(start) == QUALIFIED_START.size:
        identity, commit_bytes, repository = QUALIFIED_START.unpack(start)
        repository_id = str(uuid.UUID(bytes=repository))
    elif scenario in (b"S", b"A") and len(start) == START.size:
        identity, commit_bytes = START.unpack(start)
        repository_id = FIXTURE_REPOSITORY_ID
    else:
        raise GuestFailure("guest-input")
    commit = commit_bytes.hex()
    with TemporaryDirectory(prefix="fixed-", dir=work) as repository:
        acquire(repository, wire, commit, wire.check_deadline)
        wire.send(b"D")
        wire.receive({b"O": 0})
        # Prove that the previously approved route is closed before reading objects.
        wire.send(b"I")
        if wire.receive({b"X": len(CLOSED)})[1] != CLOSED:
            raise GuestFailure("guest-input")
        wire.send(b"M", verify_objects(repository, identity, commit))
        if scenario in (b"R", b"L", b"V"):
            verify = scenario == b"V"
            _, command = wire.receive({b"W": MAX_VERIFICATION_COMMAND if verify else MAX_REPAIR_COMMAND})
            if not command:
                raise GuestFailure("guest-input" if verify else "repair-invalid")
            mode = "verification" if verify else "repair-observation" if scenario == b"L" else "repair"
            inspect_source(repository, identity, commit, repository_id, mode, wire, command)
        elif scenario != b"S":
            mode = "qualified" if scenario == b"F" else "fixture"
            inspect_source(repository, identity, commit, repository_id, mode, wire)


def main():
    if os.geteuid() == 0:
        return 1
    deadline = time.monotonic() + 163

    def check_deadline():
        if time.monotonic() >= deadline:
            raise GuestFailure("guest-io")

    try:
        verify_workload_receipt()
        port = os.open(f"/dev/virtio-ports/{SOURCE_PORT}", os.O_RDWR | os.O_NONBLOCK | os.O_NOCTTY)
        try:
            wire = SourceWire(lambda size: os.read(port, size), lambda body: os.write(port, body), check_deadline)
            try:
                serve_source(wire, WORK)
            except GuestFailure as error:
                wire.send(b"E", str(error).encode("ascii"))
                return 1
            except (OSError, ProtocolError, subprocess.SubprocessError):
                wire.send(b"E", b"guest-io")
                return 1
        finally:
            os.close(port)
    except (KeyError, OSError, ProtocolError, GuestFailure):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
