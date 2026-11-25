import hashlib
import json
import os
import socket
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock, patch

import qualified_controller as controller
from libvirt_probe import Result, locked_workspace
from oci_artifacts import ArtifactStore


ORIGIN = "https://example.invalid/project.git"
WORKSPACE = "c" * 64


def request():
    return {
        **{name: str(uuid.uuid4()) for name in controller.IDS},
        "version": 1, "generation": 3, "fence": 8, "planSha256": "a" * 64,
        "commit": "b" * 40, "origin": ORIGIN, "workspaceSha256": WORKSPACE,
    }


def repair_request():
    data = request()
    del data["planSha256"]
    return {**data, "operation": controller.REPAIR, "operationId": str(uuid.uuid4()), "repairInputSha256": "d" * 64,
            "baseSnapshotSha256": "e" * 64}


def verification_request():
    data = request()
    del data["planSha256"]
    profile = {"runnerImageSha256": "d" * 64, "scannerInputsSha256": "e" * 64}
    manifest = "f" * 64
    frozen = {key: data[key] for key in ("version", "taskId", "runId", "projectId", "generation")}
    frozen.update({
        "source": {key: data[key] for key in ("repositoryId", "commit")}, "profile": profile,
        "inspection": {"snapshotSha256": manifest}, "subject": {"kind": "original", "manifestSha256": manifest},
    })
    return {
        **data, "operation": controller.VERIFY_SOURCE, **profile,
        "baseSnapshotSha256": manifest, "targetManifestSha256": manifest,
    }, frozen


def rule_samples_request():
    profile = {"runnerImageSha256": "d" * 64, "engineInputsSha256": "e" * 64}
    basis = {"profile": profile}
    command = json.dumps({"version": 1, "basis": basis, "candidate": {"kind": "code_rule"}}, separators=(",", ":")).encode()
    selected = {key: value for key, value in request().items() if key not in {"repositoryId", "planSha256", "commit", "origin"}}
    return {**selected, **profile, "operation": controller.VALIDATE_RULE_SAMPLES, "basisSha256": controller.json_digest(basis),
            "commandBytes": len(command), "commandSha256": hashlib.sha256(command).hexdigest()}, command


def published_inspection_request():
    data = request()
    profile = {"runnerImageSha256": "d" * 64}
    snapshot = {"document": {"purpose": "delivery", "taskId": data["taskId"], "projectId": data["projectId"]}}
    command = json.dumps({"version": 1, "rules": {"snapshot": snapshot, "profile": profile}}).encode()
    binding = {**profile, "commandBytes": len(command), "commandSha256": hashlib.sha256(command).hexdigest()}
    return {**data, "publishedCode": binding}, command


class ControllerTest(unittest.TestCase):
    def test_rule_samples_need_explicit_capability_lease_and_bound_command(self):
        data, command = rule_samples_request()
        for enabled, pulse, content, expected in (
            (False, b"K", command, "not_ready"),
            (True, b"C", command, "lease_lost"),
            (True, b"K", command[:-1] + b"]", "invalid_request"),
        ):
            launched = Mock()
            server, client = socket.socketpair()
            with self.subTest(expected=expected), server, client:
                client.sendall(json.dumps(data).encode() + b"\n" + pulse + content)
                response = controller.serve_connection(server, os.getuid(), {}, WORKSPACE, Mock(), launched, lambda: False,
                                                       enable_rule_samples=enabled)
                self.assertEqual(response, controller.rejected(expected, data["requestId"]))
                launched.assert_not_called()

    def test_rule_samples_require_verified_cleanup_and_receipt_binding(self):
        data, command = rule_samples_request()
        proof = {"version": 1, "commandSha256": data["commandSha256"], "result": {"basisSha256": data["basisSha256"]}}
        domain_id = str(uuid.uuid4())
        launched = Mock(return_value=Result("rule_samples_recorded", runId=domain_id, imageSha256=data["runnerImageSha256"],
                                           cleanupConfirmed=True, sessionVerified=True, ruleSamples=proof))
        server, client = socket.socketpair()
        with server, client:
            client.sendall(json.dumps(data).encode() + b"\nK" + command)
            response = controller.serve_connection(server, os.getuid(), {}, WORKSPACE, Mock(), launched, lambda: False,
                                                   enable_rule_samples=True)
            self.assertEqual(response, {"kind": "rule_samples_receipt", "scope": data, "domainId": domain_id, "proof": proof,
                                       "imageSha256": data["runnerImageSha256"], "cleanupConfirmed": True, "sessionVerified": True})
            self.assertEqual(launched.call_args.args[:2], (data, None))
            self.assertEqual(launched.call_args.args[3], command)
        unproven = Result("rule_samples_recorded", runId=domain_id, imageSha256=data["runnerImageSha256"], ruleSamples=proof)
        self.assertEqual(controller.response_for(data, unproven)["cleanup"], "unknown")
        altered = {**proof, "result": {"basisSha256": "f" * 64}}
        confirmed_but_wrong = Result("rule_samples_recorded", runId=domain_id, imageSha256=data["runnerImageSha256"],
                                     cleanupConfirmed=True, sessionVerified=True, ruleSamples=altered)
        self.assertEqual(controller.response_for(data, confirmed_but_wrong)["code"], "job_failed")

    def test_published_inspection_requires_registered_origin_lease_and_bound_payload(self):
        data, command = published_inspection_request()
        replaced_project = {**data, "projectId": str(uuid.uuid4())}
        for supplied, origins, enabled, pulse, content, expected in (
            (data, {ORIGIN: ORIGIN}, False, b"K", command, "not_ready"),
            (data, {}, True, b"K", command, "origin_denied"),
            (data, {ORIGIN: ORIGIN}, True, b"C", command, "lease_lost"),
            (data, {ORIGIN: ORIGIN}, True, b"K", command[:-1] + b"]", "invalid_request"),
            (replaced_project, {ORIGIN: ORIGIN}, True, b"K", command, "invalid_request"),
        ):
            server, client = socket.socketpair()
            launch = Mock()
            with self.subTest(expected=expected), server, client:
                client.sendall(json.dumps(supplied).encode() + b"\n" + pulse + content)
                response = controller.serve_connection(server, os.getuid(), origins, WORKSPACE, Mock(), launch, lambda: False,
                                                       enable_rule_samples=enabled)
                self.assertEqual(response, controller.rejected(expected, data["requestId"]))
                launch.assert_not_called()

    def test_published_inspection_returns_only_the_requested_cleaned_image_proof(self):
        data, command = published_inspection_request()
        binding = data["publishedCode"]
        proof = {"publishedCode": {"commandSha256": binding["commandSha256"]}}
        domain = str(uuid.uuid4())
        source = SimpleNamespace(originSha256="a" * 64, commitSha256="b" * 64)
        valid = Result("inspection_passed", runId=domain, imageSha256=binding["runnerImageSha256"], source=source,
                       cleanupConfirmed=True, sessionVerified=True, inspection=proof)
        server, client = socket.socketpair()
        launch = Mock(return_value=valid)
        with server, client:
            client.sendall(json.dumps(data).encode() + b"\nK" + command)
            receipt = controller.serve_connection(server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE, Mock(), launch, lambda: False,
                                                  enable_rule_samples=True)
            self.assertEqual(receipt["kind"], "receipt")
            self.assertEqual(receipt["snapshot"], proof)
            self.assertEqual(launch.call_args.args[3], command)
        original = {key: value for key, value in data.items() if key != "publishedCode"}
        self.assertEqual(controller.response_for(original, valid)["code"], "job_failed")
        wrong = Result("inspection_passed", runId=domain, imageSha256="c" * 64, source=source,
                       cleanupConfirmed=True, sessionVerified=True, inspection=proof)
        self.assertEqual(controller.response_for(data, wrong)["code"], "job_failed")

    def test_materialized_source_coordinates_are_bounded_to_an_inspection_request(self):
        basis = {"commit": "d" * 40, "baseSnapshotSha256": "e" * 64}
        data = {**request(), "materializedFrom": basis}

        def frame(value):
            return json.dumps(value).encode("ascii") + b"\n"

        self.assertEqual(controller.parse_request(frame(data)), data)
        for wrong in (
            {**data, "materializedFrom": {**basis, "commit": data["commit"]}},
            {**data, "materializedFrom": {**basis, "baseSnapshotSha256": "short"}},
            {**data, "materializedFrom": {**basis, "unexpected": "value"}},
            {**repair_request(), "commandBytes": 100, "commandSha256": "f" * 64, "materializedFrom": basis},
        ):
            with self.subTest(wrong=wrong), self.assertRaises(ValueError):
                controller.parse_request(frame(wrong))

    def test_member_and_exact_origin_are_required_before_launch(self):
        launch = Mock()
        observe = Mock()
        for uid, code, data in (
            (os.getuid() + 1, "peer_denied", b""),
            (os.getuid(), "origin_denied", json.dumps(request()).encode() + b"\n"),
            (os.getuid(), "invalid_request", b'{"version":1,"version":1}\n'),
        ):
            server, client = socket.socketpair()
            with self.subTest(code=code), server, client:
                if data:
                    client.sendall(data)
                reply = controller.serve_connection(server, uid, {}, WORKSPACE, observe, launch, lambda: False)
                self.assertEqual(reply["code"], code)
                self.assertEqual(reply["cleanup"], "not_started")
        launch.assert_not_called()
        observe.assert_not_called()

    def test_status_is_read_only_and_workspace_must_match_before_ready(self):
        launch = Mock()
        observe = Mock(return_value={"kind": "status", "state": "idle"})
        server, client = socket.socketpair()
        with server, client:
            client.sendall(controller.STATUS)
            reply = controller.serve_connection(server, os.getuid(), {}, WORKSPACE, observe, launch, lambda: False)
            self.assertEqual(reply, observe.return_value)
        server, client = socket.socketpair()
        with server, client:
            data = {**request(), "workspaceSha256": "e" * 64}
            client.sendall(json.dumps(data).encode() + b"\n")
            reply = controller.serve_connection(server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE, observe, launch, lambda: False)
            self.assertEqual(reply, controller.rejected("not_ready", data["requestId"]))
        observe.assert_called_once_with()
        launch.assert_not_called()

    def test_archive_proof_reads_only_the_exact_descriptor_for_the_worker_peer(self):
        launch, observe = Mock(), Mock()
        digest = "a" * 64
        valid = f"ARCHIVE 1 {digest} 20\n".encode("ascii")
        accepted = {"kind": "archive_verified"}
        reader = Mock(return_value=accepted)
        for uid, command, verification, expected in (
            (os.getuid() + 1, valid, reader, "peer_denied"),
            (os.getuid(), b"ARCHIVE 1 ../sample.oci.tar 20\n", reader, "invalid_request"),
            (os.getuid(), valid, None, "not_ready"),
            (os.getuid(), valid, reader, None),
            (os.getuid(), valid, Mock(side_effect=FileNotFoundError), "not_ready"),
        ):
            server, client = socket.socketpair()
            with self.subTest(expected=expected), server, client:
                client.sendall(command)
                reply = controller.serve_connection(server, uid, {}, WORKSPACE, observe, launch, lambda: False,
                                                     verify_archive=verification)
                self.assertEqual(reply, controller.rejected(expected) if expected else accepted)
        reader.assert_called_once_with({"format": controller.OCI_ARCHIVE_FORMAT, "sha256": digest, "bytes": 20})
        observe.assert_not_called()
        launch.assert_not_called()

    def test_streams_fixed_oci_bytes_only_after_worker_handshake_and_current_host_hash(self):
        launch, observe = Mock(), Mock()
        image = "1" * 64
        chunk = bytes(range(256)) * 2048
        body = chunk + chunk
        digest = hashlib.sha256(body).hexdigest()
        descriptor = {"format": controller.OCI_ARCHIVE_FORMAT, "sha256": digest, "bytes": len(body)}
        command = f"ARCHIVE_READ 1 {digest} {len(body)}\n".encode("ascii")
        ready = f"ARCHIVE_READY 1 {image}\n".encode("ascii")
        with TemporaryDirectory() as temporary, ThreadPoolExecutor(max_workers=1) as pool:
            store = ArtifactStore(temporary)
            pending = store.stage(descriptor, (chunk, chunk))

            def stream(connection, archive):
                return controller.stream_archive(connection, store, archive, image, lambda: False)

            for uid, frame, reader, reason in (
                (os.getuid() + 1, command, stream, "peer_denied"),
                (os.getuid(), command, None, "not_ready"),
                (os.getuid(), command, stream, "not_ready"),
                (os.getuid(), b"ARCHIVE_READ 1 ../layout.oci.tar 20\n", stream, "invalid_request"),
                (os.getuid(), f"ARCHIVE_READ 1 {digest} 999999999\n".encode("ascii"), stream, "not_ready"),
            ):
                server, client = socket.socketpair()
                with self.subTest(reason=reason), server, client:
                    client.sendall(frame)
                    result = controller.serve_connection(server, uid, {}, WORKSPACE, observe, launch, lambda: False,
                                                         read_archive=reader)
                    self.assertEqual(result, controller.rejected(reason))

            store.retain(pending)
            retained = Path(temporary) / (digest + ".oci.tar")
            for acknowledgement, expected_body, reason in ((b"C", b"", "lease_lost"), (b"K", body, None),
                                                            (b"K", b"x" + body[1:], "not_ready")):
                if reason == "not_ready":
                    retained.chmod(0o600)
                    retained.write_bytes(expected_body)
                    retained.chmod(0o400)
                server, client = socket.socketpair()
                with self.subTest(reason=reason), server, client, client.makefile("rb") as file:
                    client.settimeout(2)
                    future = pool.submit(controller.serve_connection, server, os.getuid(), {}, WORKSPACE, observe, launch,
                                         lambda: False, read_archive=stream)
                    client.sendall(command)
                    self.assertEqual(file.readline(), ready)
                    client.sendall(acknowledgement)
                    self.assertEqual(file.read(len(expected_body)), expected_body)
                    result = future.result(timeout=2)
                    self.assertEqual(result, controller.rejected(reason) if reason else controller.archive_verification(image, descriptor))

            retained.rename(Path(temporary) / "other.oci.tar")
            retained.symlink_to(Path(temporary) / "other.oci.tar")
            server, client = socket.socketpair()
            with server, client:
                client.sendall(command)
                result = controller.serve_connection(server, os.getuid(), {}, WORKSPACE, observe, launch, lambda: False,
                                                     read_archive=stream)
                self.assertEqual(result, controller.rejected("not_ready"))
        observe.assert_not_called()
        launch.assert_not_called()

    def test_idle_requires_same_workspace_lock_empty_staging_and_empty_session(self):
        libvirt = SimpleNamespace(libvirtError=RuntimeError)
        with TemporaryDirectory() as temporary, patch.object(controller, "prepare_session"):
            root = Path(temporary).resolve()
            fingerprint = controller.workspace_binding(root, root.stat())
            conn = Mock()
            conn.listAllDomains.return_value = []
            conn.close.return_value = 0
            with patch.object(controller, "connect", return_value=conn):
                self.assertTrue(controller.workspace_idle(libvirt, root, root, fingerprint))
                self.assertFalse(controller.workspace_idle(libvirt, root, root, "f" * 64))
                with locked_workspace(root):
                    self.assertFalse(controller.workspace_idle(libvirt, root, root, fingerprint))
                journal = root / "pending"
                journal.touch()
                self.assertFalse(controller.workspace_idle(libvirt, root, root, fingerprint))
                journal.unlink()
                conn.listAllDomains.return_value = [object()]
                self.assertFalse(controller.workspace_idle(libvirt, root, root, fingerprint))

    def test_dropping_pulses_stops_the_active_job(self):
        data = request()
        server, client = socket.socketpair()
        with server, client, ThreadPoolExecutor(max_workers=1) as pool:
            client.settimeout(1)
            with patch.object(controller, "PULSE_SECONDS", 0.1):
                def run(request_data, origin, cancelled, command):
                    self.assertFalse(cancelled())
                    self.assertEqual(request_data, data)
                    self.assertEqual(origin, ORIGIN)
                    self.assertIsNone(command)
                    idle = Event()
                    for _ in range(50):
                        if cancelled():
                            return Result("cancelled", runId=str(uuid.uuid4()), cleanupConfirmed=True, sessionVerified=True)
                        idle.wait(0.01)
                    self.fail("lease watcher did not stop the active job")

                future = pool.submit(controller.serve_connection, server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE, Mock(), run, lambda: False)
                client.sendall(json.dumps(data).encode() + b"\n")
                with client.makefile("rb", buffering=0) as reader:
                    self.assertEqual(reader.readline(len(controller.READY)), controller.READY)
                client.sendall(b"K")
                response = future.result(timeout=2)
                self.assertEqual(response["code"], "lease_lost")
                self.assertEqual(response["cleanup"], "confirmed")

    def test_uncertain_cleanup_cannot_publish_a_late_receipt(self):
        data = request()
        result = Result("cleanup_unproven", runId=str(uuid.uuid4()))
        reply = controller.response_for(data, result)
        self.assertEqual(reply, controller.rejected("cleanup_unproven", data["requestId"], "unknown", result.runId))

    def test_verification_requires_its_own_enablement_and_frozen_evidence(self):
        data, original = verification_request()
        altered = {**original, "taskId": str(uuid.uuid4())}
        launch = Mock(return_value=Result("config_required"))
        for enabled, pulse, frozen, code in (
            (False, b"", original, "not_ready"),
            (True, b"C", original, "lease_lost"),
            (True, b"K", altered, "invalid_request"),
            (True, b"K", original, "not_ready"),
        ):
            body = json.dumps({"input": frozen, "repair": None}, separators=(",", ":")).encode()
            header = {**data, "verificationInputSha256": controller.json_digest(frozen),
                      "commandSha256": hashlib.sha256(body).hexdigest(), "commandBytes": len(body)}
            server, client = socket.socketpair()
            with self.subTest(enabled=enabled, code=code), server, client, ThreadPoolExecutor(max_workers=1) as pool:
                client.settimeout(1)
                with patch.object(controller, "PULSE_SECONDS", 0.05):
                    future = pool.submit(controller.serve_connection, server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE,
                                         Mock(), launch, lambda: False, True, enabled)
                    client.sendall(json.dumps(header).encode() + b"\n")
                    if enabled:
                        with client.makefile("rb", buffering=0) as reader:
                            self.assertEqual(reader.readline(len(controller.READY)), controller.READY)
                        client.sendall(pulse + (body if pulse == b"K" else b""))
                    self.assertEqual(future.result(timeout=2), controller.rejected(code, data["requestId"]))
        launch.assert_called_once()

    def test_verification_receipt_requires_matching_target_and_scanning_inputs(self):
        data, frozen = verification_request()
        data.update(verificationInputSha256=controller.json_digest(frozen), commandSha256="a" * 64, commandBytes=1)
        domain = str(uuid.uuid4())
        proof = {"manifestSha256": data["baseSnapshotSha256"], "inputsSha256": data["scannerInputsSha256"],
                 "verificationInputSha256": data["verificationInputSha256"], "commandSha256": data["commandSha256"], "target": None}
        origin = SimpleNamespace(originSha256="a" * 64, commitSha256="b" * 64)
        options = {"runId": domain, "cleanupConfirmed": True, "sessionVerified": True,
                   "source": origin, "imageSha256": data["runnerImageSha256"]}
        reply = controller.response_for(data, Result("inspection_passed", inspection=proof, **options))
        self.assertEqual(reply["kind"], "verification_receipt")
        for changed in ({"target": {"manifestSha256": "a" * 64}}, {"inputsSha256": "b" * 64}):
            result = Result("inspection_passed", inspection={**proof, **changed}, **options)
            self.assertEqual(controller.response_for(data, result), controller.rejected("job_failed", data["requestId"], "confirmed", domain))

    def test_standard_build_is_denied_before_launch_unless_enabled(self):
        request, frozen = verification_request()
        request[controller.BUILD_PROFILE] = "9" * 64
        frozen["profile"][controller.BUILD_PROFILE] = request[controller.BUILD_PROFILE]
        command = json.dumps({"input": frozen, "repair": None}).encode()
        request.update(verificationInputSha256=controller.json_digest(frozen),
                       commandSha256=hashlib.sha256(command).hexdigest(), commandBytes=len(command))
        launch = Mock()
        server, client = socket.socketpair()
        with server, client:
            client.sendall(json.dumps(request).encode() + b"\n")
            response = controller.serve_connection(server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE, Mock(),
                                                   launch, lambda: False, enable_verification=True)
        self.assertEqual(response, controller.rejected("not_ready", request["requestId"]))
        launch.assert_not_called()
        controller.require_verification_command({"input": frozen, "repair": None}, request)
        with self.assertRaises(ValueError):
            controller.require_verification_command({"input": frozen, "repair": None},
                                                      {**request, controller.BUILD_PROFILE: "8" * 64})

    def test_standard_build_proof_cannot_be_omitted_or_rebound(self):
        request, _ = verification_request()
        request.update(buildProfileSha256="9" * 64, verificationInputSha256="7" * 64)
        snapshot = {"runId": str(uuid.uuid4())}
        self.assertFalse(controller.build_proof_matches(request, snapshot))
        build = {name: request[name] for name in ("buildProfileSha256", "verificationInputSha256")}
        build.update(runId=snapshot["runId"], subjectManifestSha256=request["targetManifestSha256"])
        self.assertTrue(controller.build_proof_matches(request, {**snapshot, "build": build}))
        self.assertFalse(controller.build_proof_matches(request, {**snapshot, "build": {**build, "subjectManifestSha256": "0" * 64}}))

    def test_baseline_requires_its_own_flag_and_exact_build_output(self):
        request, frozen = verification_request()
        flags = {controller.BUILD_PROFILE: "1" * 64, controller.RUN_BASELINE: True}
        frozen["profile"].update(flags)
        command = json.dumps({"input": frozen, "repair": None}).encode()
        request.update(flags, verificationInputSha256=controller.json_digest(frozen),
                       commandSha256=hashlib.sha256(command).hexdigest(), commandBytes=len(command))
        launch = Mock()
        server, client = socket.socketpair()
        with server, client:
            client.sendall(json.dumps(request).encode() + b"\n")
            response = controller.serve_connection(server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE, Mock(),
                                                   launch, lambda: False, enable_verification=True, enable_standard_build=True)
        self.assertEqual(response, controller.rejected("not_ready", request["requestId"]))
        launch.assert_not_called()
        domain = str(uuid.uuid4())
        evidence = {"buildProfileSha256": request["buildProfileSha256"], "runId": domain,
                    "verificationInputSha256": request["verificationInputSha256"], "subjectManifestSha256": request["targetManifestSha256"],
                    "baselineSha256": "b" * 64, "status": "built", "dist": {"sha256": "a" * 64}}
        self.assertFalse(controller.build_proof_matches(request, {"runId": domain, "build": evidence}))
        scoped = {**evidence, "baseline": {"baselineSha256": "b" * 64, "distSha256": "a" * 64}}
        self.assertTrue(controller.build_proof_matches(request, {"runId": domain, "build": scoped}))
        self.assertFalse(controller.build_proof_matches({key: val for key, val in request.items() if key != controller.RUN_BASELINE},
                                                       {"runId": domain, "build": scoped}))

    def test_health_followup_requires_bound_provenance_and_a_standard_baseline(self):
        data, frozen = verification_request()
        flags = {controller.BUILD_PROFILE: "1" * 64, controller.RUN_BASELINE: True}
        frozen["profile"].update(flags)
        frozen["healthRegression"] = {
            "proposalId": str(uuid.uuid4()), "incidentId": str(uuid.uuid4()), "sampleSequence": 1,
            "diagnosisSha256": "2" * 64, "publicationProofSha256": "3" * 64, "sampleEvidenceSha256": "4" * 64,
        }
        command = {"input": frozen, "repair": None}
        encoded = json.dumps(command).encode()
        data.update(flags, healthFollowup=True, verificationInputSha256=controller.json_digest(frozen),
                    commandSha256=hashlib.sha256(encoded).hexdigest(), commandBytes=len(encoded))
        parsed = controller.parse_request(json.dumps(data).encode() + b"\n")
        self.assertEqual(parsed, data)
        controller.require_verification_command(command, data)
        for field in (controller.HEALTH_FOLLOWUP, controller.RUN_BASELINE):
            missing = {key: value for key, value in data.items() if key != field}
            with self.subTest(field=field), self.assertRaises(ValueError):
                if field == controller.HEALTH_FOLLOWUP:
                    controller.require_verification_command(command, missing)
                else:
                    controller.parse_request(json.dumps(missing).encode() + b"\n")

    def test_oci_requires_its_own_flag_and_a_passing_bound_baseline(self):
        request, frozen = verification_request()
        flags = {controller.BUILD_PROFILE: "1" * 64, controller.RUN_BASELINE: True, controller.OCI_INPUTS: "2" * 64}
        frozen["profile"].update(flags)
        command = json.dumps({"input": frozen, "repair": None}).encode()
        request.update(flags, verificationInputSha256=controller.json_digest(frozen),
                       commandSha256=hashlib.sha256(command).hexdigest(), commandBytes=len(command))
        launch = Mock()
        server, client = socket.socketpair()
        with server, client:
            client.sendall(json.dumps(request).encode() + b"\n")
            response = controller.serve_connection(server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE, Mock(),
                                                   launch, lambda: False, enable_verification=True,
                                                   enable_standard_build=True, enable_baseline=True)
        self.assertEqual(response, controller.rejected("not_ready", request["requestId"]))
        launch.assert_not_called()
        domain = str(uuid.uuid4())
        baseline = {"status": "passed", "baselineSha256": "b" * 64, "distSha256": "d" * 64,
                    "runtimeInputsSha256": "a" * 64}
        build = {"buildProfileSha256": request["buildProfileSha256"], "runId": domain,
                 "verificationInputSha256": request["verificationInputSha256"], "subjectManifestSha256": request["targetManifestSha256"],
                 "baselineSha256": "b" * 64, "status": "built", "dist": {"sha256": "d" * 64}, "baseline": baseline}
        evidence = {"runId": domain, "build": build}
        self.assertFalse(controller.build_proof_matches(request, evidence))
        baseline["image"] = {"ociInputsSha256": "2" * 64, "runtimeInputsSha256": "a" * 64}
        self.assertTrue(controller.build_proof_matches(request, evidence))
        baseline["image"]["ociInputsSha256"] = "3" * 64
        self.assertFalse(controller.build_proof_matches(request, evidence))
        baseline["status"] = "failed"
        self.assertFalse(controller.build_proof_matches(request, evidence))
        del baseline["image"]
        self.assertTrue(controller.build_proof_matches(request, evidence))

    def test_repair_requires_enablement_current_pulse_and_exact_command_before_launch(self):
        data = repair_request()
        scope = {name: data[name] for name in ("operationId", "repairInputSha256", "baseSnapshotSha256")}
        workspace = {**scope, "source": {"repositoryId": data["repositoryId"], "commit": data["commit"]}}
        proposal = {"baseSnapshotSha256": data["baseSnapshotSha256"]}
        body = json.dumps({"workspace": workspace, "patch": proposal}).encode()
        original = {**data, "commandSha256": hashlib.sha256(body).hexdigest(), "commandBytes": len(body)}
        confused = {**original, "operation": controller.OBSERVE_REPAIR}
        stale = json.dumps({"workspace": workspace, "patch": {"baseSnapshotSha256": "f" * 64}}).encode()
        stale_request = {**data, "commandSha256": hashlib.sha256(stale).hexdigest(), "commandBytes": len(stale)}
        launch = Mock(return_value=Result("not_ready"))
        for enabled, header, authorization, outcome in (
            (False, original, b"", "not_ready"),
            (True, original, b"C", "lease_lost"),
            (True, original, b"K" + b"[" * len(body), "invalid_request"),
            (True, confused, b"K" + body, "invalid_request"),
            (True, stale_request, b"K" + stale, "invalid_request"),
            (True, original, b"K" + body, "not_ready"),
        ):
            server, client = socket.socketpair()
            with self.subTest(enabled=enabled, outcome=outcome), server, client, ThreadPoolExecutor(max_workers=1) as pool:
                client.settimeout(1)
                with patch.object(controller, "PULSE_SECONDS", 0.05):
                    result = pool.submit(controller.serve_connection, server, os.getuid(), {ORIGIN: ORIGIN}, WORKSPACE,
                                         Mock(), launch, lambda: False, enabled)
                    client.sendall(json.dumps(header).encode() + b"\n")
                    if enabled:
                        with client.makefile("rb", buffering=0) as reader:
                            self.assertEqual(reader.readline(len(controller.READY)), controller.READY)
                        client.sendall(authorization)
                    self.assertEqual(result.result(timeout=2), controller.rejected(outcome, data["requestId"]))
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[:2], (original, ORIGIN))
        self.assertEqual(launch.call_args.args[3], body)
