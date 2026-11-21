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


class ControllerTest(unittest.TestCase):
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
