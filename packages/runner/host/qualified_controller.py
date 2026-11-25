"""Local, single-job controller for the dedicated KVM account."""

import hashlib
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
from dataclasses import replace
from pathlib import Path
from threading import Event, Thread
from urllib.parse import urlsplit

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from libvirt_probe import IMAGE_DIGEST, Rejected, Result, check_kvm, closed, connect, locked_workspace, probe, start_channel_events
from native_source import RuleSamplesProbe, SourceProbe
from oci_artifacts import ArtifactStore
from session_boundary import SESSION_URI, SessionRejected, prepare_session
from source_gateway import COMMIT, RegisteredOrigin, SourceGateway, SourceRejected
from source_wire import (GUEST_REPAIR_ERRORS, MAX_OCI_CHUNK_BYTES, MAX_QUALIFIED_RECEIPT, MAX_REPAIR_COMMAND,
                         MAX_PUBLISHED_INSPECTION_COMMAND, MAX_PUBLISHED_INSPECTION_PROOF,
                         MAX_PUBLISHED_VERIFICATION_COMMAND, MAX_PUBLISHED_VERIFICATION_PROOF,
                         MAX_VERIFICATION_COMMAND, MAX_VERIFICATION_RECEIPT, MAX_RULE_VALIDATION_COMMAND, OCI_ARCHIVE_FORMAT)


REQUEST_LIMIT = 2048
HANDSHAKE_SECONDS = 3
PULSE_SECONDS = 2
READY = b"READY 1\n"
STATUS = b"STATUS 1\n"
ARCHIVE_REQUEST = re.compile(rb"(ARCHIVE|ARCHIVE_READ) 1 ([0-9a-f]{64}) ([1-9][0-9]{0,8})\n")
ARCHIVE_READ_SECONDS = 60
IDS = ("requestId", "taskId", "runId", "projectId", "repositoryId")
COUNTERS = ("generation", "fence")
FIELDS = {*IDS, *COUNTERS, "version", "planSha256", "workspaceSha256", "commit", "origin"}
REPAIR = "apply_repair"
OBSERVE_REPAIR = "observe_repair"
VERIFY_SOURCE = "verify_source"
VALIDATE_RULE_SAMPLES = "validate_rule_samples"
REPAIR_OPERATIONS = (REPAIR, OBSERVE_REPAIR)
REPAIR_DIGESTS = ("repairInputSha256", "baseSnapshotSha256", "commandSha256")
REPAIR_FIELDS = (FIELDS - {"planSha256"}) | {"operation", "operationId", "commandBytes", *REPAIR_DIGESTS}
VERIFY_DIGESTS = ("verificationInputSha256", "baseSnapshotSha256", "targetManifestSha256",
                  "runnerImageSha256", "scannerInputsSha256", "commandSha256")
VERIFY_FIELDS = (FIELDS - {"planSha256"}) | {"operation", "commandBytes", *VERIFY_DIGESTS}
RULE_SAMPLE_DIGESTS = ("workspaceSha256", "runnerImageSha256", "basisSha256", "engineInputsSha256", "commandSha256")
RULE_SAMPLE_FIELDS = {"operation", "version", "commandBytes", *IDS[:-1], *COUNTERS, *RULE_SAMPLE_DIGESTS}
BUILD_PROFILE = "buildProfileSha256"
RUN_BASELINE = "runStandardBaseline"
HEALTH_FOLLOWUP = "healthFollowup"
OCI_INPUTS = "ociInputsSha256"
RETAIN_IMAGE = "retainStandardImage"
MATERIALIZED_SOURCE = "materializedFrom"
PUBLISHED_CODE = "publishedCode"
PUBLISHED_VERIFICATION = "publishedCodeRuleSetSha256"
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
    operation = data.get("operation")
    if operation == VALIDATE_RULE_SAMPLES:
        if (data.keys() != RULE_SAMPLE_FIELDS or type(data["version"]) is not int or data["version"] != 1
                or not all(is_v4(data[name]) for name in IDS[:-1])
                or not all(type(data[name]) is int and 0 < data[name] <= 2147483647 for name in COUNTERS)
                or type(data["commandBytes"]) is not int or not 0 < data["commandBytes"] <= MAX_RULE_VALIDATION_COMMAND
                or not all(isinstance(data[name], str) and IMAGE_DIGEST.fullmatch(data[name]) for name in RULE_SAMPLE_DIGESTS)):
            raise ValueError("Invalid rule samples request")
        return data
    repair = operation in REPAIR_OPERATIONS
    verification = operation == VERIFY_SOURCE
    build = verification and BUILD_PROFILE in data
    fields = VERIFY_FIELDS if verification else REPAIR_FIELDS if repair else FIELDS
    if not repair and not verification and MATERIALIZED_SOURCE in data:
        fields = fields | {MATERIALIZED_SOURCE}
    if operation is None and PUBLISHED_CODE in data:
        fields = fields | {PUBLISHED_CODE}
    if verification and PUBLISHED_VERIFICATION in data:
        fields = fields | {PUBLISHED_VERIFICATION}
    if build:
        fields = fields | {BUILD_PROFILE}
        if RUN_BASELINE in data:
            if data[RUN_BASELINE] is not True:
                raise ValueError("invalid baseline request")
            fields = fields | {RUN_BASELINE}
            if HEALTH_FOLLOWUP in data:
                if data[HEALTH_FOLLOWUP] is not True:
                    raise ValueError("invalid health follow-up request")
                fields = fields | {HEALTH_FOLLOWUP}
            if OCI_INPUTS in data:
                fields = fields | {OCI_INPUTS}
                if RETAIN_IMAGE in data:
                    if data[RETAIN_IMAGE] is not True:
                        raise ValueError("invalid artifact retention request")
                    fields = fields | {RETAIN_IMAGE}
    if data.keys() != fields or type(data["version"]) is not int or data["version"] != 1:
        raise ValueError("invalid request fields")
    if not all(is_v4(data[name]) for name in IDS) or (repair and not is_v4(data["operationId"])):
        raise ValueError("invalid request identity")
    if not all(type(data[name]) is int and 0 < data[name] <= 2147483647 for name in COUNTERS):
        raise ValueError("invalid request authority")
    digests = VERIFY_DIGESTS if verification else REPAIR_DIGESTS if repair else ("planSha256",)
    if build:
        digests += (BUILD_PROFILE,)
    if OCI_INPUTS in fields:
        digests += (OCI_INPUTS,)
    if PUBLISHED_VERIFICATION in fields:
        digests += (PUBLISHED_VERIFICATION,)
    patterns = {name: IMAGE_DIGEST for name in (*digests, "workspaceSha256")}
    patterns["commit"] = COMMIT
    for name, pattern in patterns.items():
        if not isinstance(data[name], str) or not pattern.fullmatch(data[name]):
            raise ValueError("invalid fixed reference")
    if MATERIALIZED_SOURCE in fields:
        basis = data[MATERIALIZED_SOURCE]
        if (not isinstance(basis, dict) or basis.keys() != {"commit", "baseSnapshotSha256"}
            or not isinstance(basis["commit"], str) or not COMMIT.fullmatch(basis["commit"])
            or basis["commit"] == data["commit"] or not isinstance(basis["baseSnapshotSha256"], str)
            or not IMAGE_DIGEST.fullmatch(basis["baseSnapshotSha256"])):
            raise ValueError("invalid materialized source reference")
    if PUBLISHED_CODE in fields:
        binding = data[PUBLISHED_CODE]
        if (not isinstance(binding, dict) or binding.keys() != {"commandSha256", "commandBytes", "runnerImageSha256"}
            or type(binding["commandBytes"]) is not int or not 0 < binding["commandBytes"] <= MAX_PUBLISHED_INSPECTION_COMMAND
            or not all(isinstance(binding[key], str) and IMAGE_DIGEST.fullmatch(binding[key])
                       for key in ("commandSha256", "runnerImageSha256"))):
            raise ValueError("invalid published inspection command binding")
    if repair or verification:
        limit = MAX_VERIFICATION_COMMAND if verification else MAX_REPAIR_COMMAND
        if PUBLISHED_VERIFICATION in fields:
            limit = MAX_PUBLISHED_VERIFICATION_COMMAND
        if type(data["commandBytes"]) is not int or not 0 < data["commandBytes"] <= limit:
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


def json_digest(value):
    canonical = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def require_verification_command(command, request):
    expected_rules = request.get(PUBLISHED_VERIFICATION)
    fields = {"input", "repair", "publishedCodeRules"} if expected_rules else {"input", "repair"}
    if not isinstance(command, dict) or command.keys() != fields:
        raise ValueError("invalid verification command")
    frozen = command["input"]
    source = {"repositoryId": request["repositoryId"], "commit": request["commit"]}
    if (not isinstance(frozen, dict) or frozen.get("source") != source
        or any(frozen.get(field) != request[field] for field in ("version", "taskId", "runId", "projectId", "generation"))
        or json_digest(frozen) != request["verificationInputSha256"]):
        raise ValueError("verification command authority mismatch")
    inspection, profile, subject = (frozen.get(key) for key in ("inspection", "profile", "subject"))
    if (not all(isinstance(value, dict) for value in (inspection, profile, subject))
        or inspection.get("snapshotSha256") != request["baseSnapshotSha256"]
        or subject.get("manifestSha256") != request["targetManifestSha256"]
        or profile.get(BUILD_PROFILE) != request.get(BUILD_PROFILE)
        or profile.get(RUN_BASELINE) != request.get(RUN_BASELINE)
        or profile.get(OCI_INPUTS) != request.get(OCI_INPUTS)
        or profile.get(RETAIN_IMAGE) != request.get(RETAIN_IMAGE)
        or any(profile.get(key) != request[key] for key in ("runnerImageSha256", "scannerInputsSha256"))):
        raise ValueError("verification command evidence mismatch")
    if ("healthRegression" in frozen) != (HEALTH_FOLLOWUP in request):
        raise ValueError("verification health follow-up mismatch")
    if (PUBLISHED_CODE in frozen) != (expected_rules is not None):
        raise ValueError("verification published rule evidence missing")
    if expected_rules is not None:
        binding = frozen[PUBLISHED_CODE]
        rules = command["publishedCodeRules"]
        snapshot = require_published_rule_scope(rules, request, request["runnerImageSha256"])
        if (not isinstance(binding, dict) or binding.keys() != {"snapshotSha256", "inspectionScanSha256", "ruleSetSha256"}
            or not all(isinstance(value, str) and IMAGE_DIGEST.fullmatch(value) for value in binding.values())
            or binding["ruleSetSha256"] != expected_rules or json_digest(rules) != expected_rules
            or binding["snapshotSha256"] != snapshot.get("sha256")):
            raise ValueError("verification published rule binding mismatch")
    if HEALTH_FOLLOWUP in request:
        case = frozen["healthRegression"]
        digests = ("diagnosisSha256", "publicationProofSha256", "sampleEvidenceSha256")
        if (not isinstance(case, dict) or case.keys() != {"proposalId", "incidentId", "sampleSequence", *digests}
            or not all(is_v4(case[name]) for name in ("proposalId", "incidentId"))
            or not all(isinstance(case[name], str) and IMAGE_DIGEST.fullmatch(case[name]) for name in digests)
            or type(case["sampleSequence"]) is not int or not 0 < case["sampleSequence"] <= 9007199254740991):
            raise ValueError("invalid health follow-up provenance")
    repair = command["repair"]
    same_snapshot = request["baseSnapshotSha256"] == request["targetManifestSha256"]
    if subject.get("kind") == "original" and same_snapshot and repair is None:
        return
    if (subject.get("kind") != "repair" or same_snapshot or not isinstance(repair, dict)
        or repair.keys() != {"workspace", "patch"}
        or json_digest(repair) != subject.get("commandSha256")
        or json_digest(repair["patch"]) != subject.get("patchSha256")):
        raise ValueError("verification repair evidence mismatch")


def require_published_rule_scope(rules, request, image_sha256):
    snapshot = rules.get("snapshot") if isinstance(rules, dict) else None
    profile = rules.get("profile") if isinstance(rules, dict) else None
    document = snapshot.get("document") if isinstance(snapshot, dict) else None
    if (not isinstance(document, dict) or document.get("purpose") != "delivery"
        or any(document.get(key) != request[key] for key in ("taskId", "projectId"))
        or not isinstance(profile, dict) or profile.get("runnerImageSha256") != image_sha256):
        raise ValueError("published rule command authority mismatch")
    return snapshot


def require_published_inspection_command(command, request):
    fields = {"version", "rules"}
    if MATERIALIZED_SOURCE in request:
        fields.add(MATERIALIZED_SOURCE)
    if (not isinstance(command, dict) or command.keys() != fields or type(command["version"]) is not int
        or command["version"] != 1 or command.get(MATERIALIZED_SOURCE) != request.get(MATERIALIZED_SOURCE)):
        raise ValueError("invalid published inspection command")
    require_published_rule_scope(command["rules"], request, request[PUBLISHED_CODE]["runnerImageSha256"])


def read_command(connection, request):
    expires = time.monotonic() + HANDSHAKE_SECONDS
    binding = request.get(PUBLISHED_CODE, request)
    size = binding["commandBytes"]
    data = bytearray()
    while len(data) < size:
        remaining = expires - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        connection.settimeout(remaining)
        block = connection.recv(min(65536, size - len(data)))
        if not block:
            raise ValueError("truncated runner command")
        data.extend(block)
    if hashlib.sha256(data).hexdigest() != binding["commandSha256"]:
        raise ValueError("runner command digest mismatch")
    command = json.loads(data, object_pairs_hook=unique_fields)
    if PUBLISHED_CODE in request:
        require_published_inspection_command(command, request)
        return bytes(data)
    if request["operation"] == VALIDATE_RULE_SAMPLES:
        if (not isinstance(command, dict) or command.keys() != {"version", "basis", "candidate"}
                or type(command["version"]) is not int or command["version"] != 1
                or not isinstance(command["basis"], dict) or not isinstance(command["candidate"], dict)
                or command["candidate"].get("kind") != "code_rule" or json_digest(command["basis"]) != request["basisSha256"]):
            raise ValueError("Invalid rule samples command binding")
        profile = command["basis"].get("profile")
        if (not isinstance(profile, dict) or profile.get("runnerImageSha256") != request["runnerImageSha256"]
                or profile.get("engineInputsSha256") != request["engineInputsSha256"]):
            raise ValueError("Invalid rule samples profile binding")
        return bytes(data)
    if request["operation"] == VERIFY_SOURCE:
        require_verification_command(command, request)
        return bytes(data)
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


def build_proof_matches(request, snapshot):
    if BUILD_PROFILE not in request:
        return "build" not in snapshot
    proof = snapshot.get("build")
    if not (
        isinstance(proof, dict) and proof.get(BUILD_PROFILE) == request[BUILD_PROFILE]
        and proof.get("runId") == snapshot.get("runId")
        and proof.get("verificationInputSha256") == request["verificationInputSha256"]
        and proof.get("subjectManifestSha256") == request["targetManifestSha256"]
    ):
        return False
    if RUN_BASELINE not in request or proof.get("status") != "built":
        return "baseline" not in proof
    baseline, dist = proof.get("baseline"), proof.get("dist")
    if not (isinstance(baseline, dict) and isinstance(dist, dict)
            and baseline.get("baselineSha256") == proof.get("baselineSha256")
            and baseline.get("distSha256") == dist.get("sha256")):
        return False
    followup = baseline.get(HEALTH_FOLLOWUP)
    completed = baseline.get("status") in ("passed", "failed")
    if (HEALTH_FOLLOWUP in baseline) != (HEALTH_FOLLOWUP in request and completed):
        return False
    if HEALTH_FOLLOWUP in baseline and (not isinstance(followup, dict) or followup.get("status") not in ("passed", "unhealthy", "unavailable")):
        return False
    if OCI_INPUTS not in request or baseline.get("status") != "passed" or (followup and followup["status"] != "passed"):
        return "image" not in baseline
    image = baseline.get("image")
    return (isinstance(image, dict) and image.get(OCI_INPUTS) == request[OCI_INPUTS]
            and image.get("runtimeInputsSha256") == baseline.get("runtimeInputsSha256")
            and ("archive" in image) == (RETAIN_IMAGE in request and image.get("status") == "scanned"))


def verification_proof_matches(request, snapshot, image_sha256):
    target = snapshot.get("target")
    same_snapshot = request["baseSnapshotSha256"] == request["targetManifestSha256"]
    return (
        image_sha256 == request["runnerImageSha256"]
        and snapshot.get("manifestSha256") == request["baseSnapshotSha256"]
        and snapshot.get("inputsSha256") == request["scannerInputsSha256"]
        and snapshot.get("verificationInputSha256") == request["verificationInputSha256"]
        and snapshot.get("commandSha256") == request["commandSha256"]
        and build_proof_matches(request, snapshot)
        and published_verification_proof_matches(request, snapshot, same_snapshot)
        and (("target" in snapshot and target is None) if same_snapshot
             else isinstance(target, dict) and target.get("manifestSha256") == request["targetManifestSha256"])
    )


def published_verification_proof_matches(request, snapshot, same_snapshot):
    expected_rules = request.get(PUBLISHED_VERIFICATION)
    if expected_rules is None:
        return PUBLISHED_CODE not in snapshot
    measured = snapshot.get(PUBLISHED_CODE)
    if not isinstance(measured, dict) or measured.get("kind") != ("original" if same_snapshot else "repair"):
        return False
    scan = measured.get("scan")
    document = scan.get("document") if isinstance(scan, dict) else None
    basis = document.get("basis") if isinstance(document, dict) else None
    return (isinstance(basis, dict) and basis.get("manifestSha256") == request["targetManifestSha256"]
            and basis.get("ruleSetSha256") == expected_rules)


def response_for(request, result):
    request_id = request["requestId"]
    rule_samples = request.get("operation") == VALIDATE_RULE_SAMPLES
    if rule_samples and result.code == "rule_samples_recorded" and result.cleanupConfirmed and result.sessionVerified:
        proof = result.ruleSamples
        if (result.runId and result.imageSha256 == request["runnerImageSha256"] and isinstance(proof, dict)
                and proof.keys() == {"version", "commandSha256", "result"} and proof["commandSha256"] == request["commandSha256"]
                and isinstance(proof["result"], dict) and proof["result"].get("basisSha256") == request["basisSha256"]):
            return {"kind": "rule_samples_receipt", "scope": request, "domainId": result.runId,
                    "imageSha256": result.imageSha256, "cleanupConfirmed": True, "sessionVerified": True, "proof": proof}
    repair = request.get("operation") in REPAIR_OPERATIONS
    verification = request.get("operation") == VERIFY_SOURCE
    observation = request.get("operation") == OBSERVE_REPAIR
    expected_code = "repair_passed" if repair else "inspection_passed"
    snapshot = result.repair if repair else result.inspection
    if (
        not rule_samples and result.code == expected_code and result.cleanupConfirmed and result.sessionVerified
        and result.runId and result.imageSha256 and result.source and isinstance(snapshot, dict) and snapshot
    ):
        evidence = snapshot.get("observation" if observation else "candidate") if repair else None
        repair_matches = not repair or (
            snapshot.get("commandSha256") == request["commandSha256"] and isinstance(evidence, dict)
            and snapshot.get("manifestSha256") == evidence.get("baseSnapshotSha256") == request["baseSnapshotSha256"]
            and evidence.get("repairInputSha256") == request["repairInputSha256"] and evidence.get("operationId") == request["operationId"]
        )
        materialized = snapshot.get("materializedCandidateSha256")
        materialized_matches = (isinstance(materialized, str) and bool(IMAGE_DIGEST.fullmatch(materialized))
                                if MATERIALIZED_SOURCE in request else "materializedCandidateSha256" not in snapshot)
        published = request.get(PUBLISHED_CODE)
        proof = snapshot.get(PUBLISHED_CODE)
        publication_matches = verification or (PUBLISHED_CODE not in snapshot if published is None else
                               isinstance(proof, dict) and proof.get("commandSha256") == published["commandSha256"]
                               and result.imageSha256 == published["runnerImageSha256"])
        if (repair_matches and materialized_matches and publication_matches
            and (not verification or verification_proof_matches(request, snapshot, result.imageSha256))):
            kind = ("verification_receipt" if verification else "repair_observation" if observation
                    else "repair_receipt" if repair else "receipt")
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


def archive_verification(image_sha256, archive):
    return {"kind": "archive_verified", "version": 1, "runnerImageSha256": image_sha256, "archive": archive}


def stream_archive(connection, store, archive, image_sha256, stopping):
    with store.open_retained(archive) as file:
        connection.sendall(f"ARCHIVE_READY 1 {image_sha256}\n".encode("ascii"))
        if connection.recv(1) != b"K" or stopping():
            return rejected("lease_lost")
        deadline = time.monotonic() + ARCHIVE_READ_SECONDS
        digest = hashlib.sha256()
        remaining = archive["bytes"]
        while remaining:
            chunk = file.read(min(MAX_OCI_CHUNK_BYTES, remaining))
            if not chunk:
                raise ValueError("truncated OCI archive")
            timeout = min(HANDSHAKE_SECONDS, deadline - time.monotonic())
            if timeout <= 0 or stopping():
                raise TimeoutError("OCI stream expired")
            connection.settimeout(timeout)
            connection.sendall(chunk)
            remaining -= len(chunk)
            digest.update(chunk)
        if file.read(1) or digest.hexdigest() != archive["sha256"]:
            raise ValueError("stored OCI archive differs from receipt")
        if stopping() or time.monotonic() >= deadline:
            raise TimeoutError("OCI stream expired")
    return archive_verification(image_sha256, archive)


def serve_connection(connection, worker_uid, origins, fingerprint, observe, launch, stopping,
                     enable_repair=False, enable_verification=False, enable_standard_build=False, enable_baseline=False,
                     enable_oci=False, enable_retention=False, verify_archive=None, read_archive=None, enable_rule_samples=False):
    connection.settimeout(HANDSHAKE_SECONDS)
    _, uid, _ = PEER.unpack(connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, PEER.size))
    if uid != worker_uid:
        return rejected("peer_denied")
    try:
        frame = read_frame(connection)
        if frame == STATUS:
            return observe()
        archive_request = ARCHIVE_REQUEST.fullmatch(frame)
        if archive_request:
            command, sha256, size = archive_request.groups()
            if stopping() or (read_archive if command == b"ARCHIVE_READ" else verify_archive) is None:
                return rejected("not_ready")
            archive = {"format": OCI_ARCHIVE_FORMAT, "sha256": sha256.decode("ascii"), "bytes": int(size)}
            try:
                if command == b"ARCHIVE_READ":
                    return read_archive(connection, archive)
                return verify_archive(archive)
            except (OSError, ValueError):
                return rejected("not_ready")
        request = parse_request(frame)
    except (OSError, ValueError, RecursionError):
        return rejected("invalid_request")
    repair = request.get("operation") in REPAIR_OPERATIONS
    verification = request.get("operation") == VERIFY_SOURCE
    rule_samples = request.get("operation") == VALIDATE_RULE_SAMPLES
    published_code = PUBLISHED_CODE in request
    if (request["workspaceSha256"] != fingerprint or (repair and not enable_repair)
        or ((rule_samples or published_code or PUBLISHED_VERIFICATION in request) and not enable_rule_samples)
        or (verification and not enable_verification) or (BUILD_PROFILE in request and not enable_standard_build)
        or (RUN_BASELINE in request and not enable_baseline) or (OCI_INPUTS in request and not enable_oci)
        or (RETAIN_IMAGE in request and not enable_retention)):
        return rejected("not_ready", request["requestId"])
    origin = None if rule_samples else origins.get(request["origin"])
    if not rule_samples and origin is None:
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
        command = read_command(connection, request) if repair or verification or rule_samples or published_code else None
    except (OSError, ValueError, RecursionError):
        return rejected("invalid_request", request["requestId"])
    if stopping():
        return rejected("lease_lost", request["requestId"])
    with LiveConnection(connection, stopping) as live:
        result = launch(request, origin, live.cancelled, command)
    response = response_for(request, result)
    if response["kind"] == "rejected":
        diagnostics = {"code": result.code, "profile": result.profileIssue, "job": result.jobIssue}
        safe = {key: value for key, value in diagnostics.items()
                if value is not None and re.fullmatch(r"[a-z0-9_-]{1,96}", value)}
        print("itervane-domain-result " + json.dumps(safe, separators=(",", ":")), file=sys.stderr, flush=True)
    return response


def socket_parent(path):
    parent = path.parent
    if not path.is_absolute() or not path.name.endswith(".sock") or len(os.fsencode(path)) > 100 or parent.resolve(strict=True) != parent:
        raise ValueError("invalid socket path")
    metadata = parent.stat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
        raise ValueError("invalid socket directory")


def run_server(path, worker_uid, origins, fingerprint, observe, launch, stopping, enable_repair, enable_verification,
               enable_standard_build, enable_baseline, enable_oci, enable_retention, verify_archive, read_archive, enable_rule_samples=False):
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
                        result = serve_connection(connection, worker_uid, origins, fingerprint, observe, launch, stopping,
                                                  enable_repair, enable_verification, enable_standard_build, enable_baseline,
                                                  enable_oci, enable_retention, verify_archive, read_archive, enable_rule_samples)
                        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
                        scope = result.get("scope", {})
                        if result["kind"] == "verification_receipt":
                            limit = MAX_PUBLISHED_VERIFICATION_PROOF if PUBLISHED_VERIFICATION in scope else MAX_VERIFICATION_RECEIPT
                        else:
                            limit = MAX_PUBLISHED_INSPECTION_PROOF if PUBLISHED_CODE in scope else MAX_QUALIFIED_RECEIPT
                        if len(encoded) > limit + 8192:
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
        features = set()
        artifact_store = None
        while allowed and allowed[0] in ("--enable-repair", "--enable-verification", "--enable-standard-build",
                                        "--enable-standard-baseline", "--enable-standard-oci", "--enable-rule-samples", "--artifact-store"):
            flag = allowed.pop(0)
            if flag in features:
                raise ValueError("duplicate capability")
            features.add(flag)
            if flag == "--artifact-store":
                if not allowed:
                    raise ValueError("missing artifact store path")
                artifact_store = ArtifactStore(allowed.pop(0))
        worker_uid = int(name)
        if (
            not 0 < worker_uid < 2**31 or worker_uid == os.geteuid()
            or not IMAGE_DIGEST.fullmatch(digest) or not 1 <= len(allowed) <= 16
            or not root.is_absolute() or root.resolve(strict=True) != root or not image.is_absolute()
        ):
            raise ValueError("invalid runner configuration")
        if artifact_store and ("--enable-standard-oci" not in features or artifact_store.root.is_relative_to(root)
                               or root.is_relative_to(artifact_store.root)):
            raise ValueError("artifact store must be separate from the VM workspace")
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

        def verify_archive(archive):
            artifact_store.verify_retained(archive)
            return archive_verification(digest, archive)

        def read_archive(connection, archive):
            return stream_archive(connection, artifact_store, archive, digest, stopped)

        def launch(request, origin, cancelled, command):
            verification = request.get("operation") == VERIFY_SOURCE
            rule_samples = request.get("operation") == VALIDATE_RULE_SAMPLES
            published_code = request.get(PUBLISHED_CODE)
            if (verification or rule_samples) and request["runnerImageSha256"] != digest:
                return Result("config_required")
            if published_code is not None and published_code["runnerImageSha256"] != digest:
                return Result("config_required")
            if not workspace_idle(libvirt, root, image, fingerprint):
                return Result("pending_cleanup")
            if rule_samples:
                return probe(libvirt, libvirt_qemu, root, image, digest, cancelled, "inspect", True,
                             source_override=RuleSamplesProbe(command))
            storage = artifact_store if RETAIN_IMAGE in request else None
            materialized = (json.dumps(request[MATERIALIZED_SOURCE], separators=(",", ":")).encode("ascii")
                            if MATERIALIZED_SOURCE in request and published_code is None else None)
            job = SourceProbe(SourceGateway(origin, request["commit"]), repository_id=request["repositoryId"],
                              repair_command=None if verification or published_code is not None else command,
                              repair_observation=request.get("operation") == OBSERVE_REPAIR, verification_command=command if verification else None,
                              artifact_store=storage, materialized_source=materialized, published_code_command=command if published_code is not None else None,
                              published_verification=PUBLISHED_VERIFICATION in request)
            try:
                result = probe(libvirt, libvirt_qemu, root, image, digest, cancelled, "inspect", True, source_override=job)
                if storage is None or job.pending_archive is None:
                    return result
                if cancelled():
                    return replace(result, code="cancelled", inspection=None)
                if response_for(request, result)["kind"] == "verification_receipt":
                    try:
                        storage.retain(job.pending_archive)
                    except (OSError, ValueError):
                        return replace(result, code="job_failed", inspection=None)
                return result
            finally:
                if storage and job.pending_archive:
                    storage.discard(job.pending_archive)

        run_server(path, worker_uid, origins, fingerprint, observe, launch, stopped,
                   "--enable-repair" in features, "--enable-verification" in features, "--enable-standard-build" in features,
                   "--enable-standard-baseline" in features, "--enable-standard-oci" in features, artifact_store is not None,
                   verify_archive if artifact_store else None, read_archive if artifact_store else None, "--enable-rule-samples" in features)
    except (ImportError, OSError, ValueError, Rejected, SessionRejected, SourceRejected):
        print("Qualified inspection controller could not start.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
