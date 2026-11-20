import json
import os
import socket
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock, patch

import qualified_controller as controller
from libvirt_probe import Result


ORIGIN = "https://example.invalid/project.git"


def request():
    return {
        **{name: str(uuid.uuid4()) for name in controller.IDS},
        "version": 1, "generation": 3, "fence": 8, "planSha256": "a" * 64,
        "commit": "b" * 40, "origin": ORIGIN,
    }


class ControllerTest(unittest.TestCase):
    def test_member_and_exact_origin_are_required_before_launch(self):
        launch = Mock()
        for uid, code, data in (
            (os.getuid() + 1, "peer_denied", b""),
            (os.getuid(), "origin_denied", json.dumps(request()).encode() + b"\n"),
            (os.getuid(), "invalid_request", b'{"version":1,"version":1}\n'),
        ):
            server, client = socket.socketpair()
            with self.subTest(code=code), server, client:
                if data:
                    client.sendall(data)
                reply = controller.serve_connection(server, uid, {}, launch, lambda: False)
                self.assertEqual(reply["code"], code)
                self.assertEqual(reply["cleanup"], "not_started")
        launch.assert_not_called()

    def test_dropping_pulses_stops_the_active_job(self):
        data = request()
        server, client = socket.socketpair()
        with server, client, ThreadPoolExecutor(max_workers=1) as pool:
            client.settimeout(1)
            with patch.object(controller, "PULSE_SECONDS", 0.1):
                def run(request_data, origin, cancelled):
                    self.assertFalse(cancelled())
                    self.assertEqual(request_data, data)
                    self.assertEqual(origin, ORIGIN)
                    idle = Event()
                    for _ in range(50):
                        if cancelled():
                            return Result("cancelled", runId=str(uuid.uuid4()), cleanupConfirmed=True, sessionVerified=True)
                        idle.wait(0.01)
                    self.fail("lease watcher did not stop the active job")

                future = pool.submit(controller.serve_connection, server, os.getuid(), {ORIGIN: ORIGIN}, run, lambda: False)
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
