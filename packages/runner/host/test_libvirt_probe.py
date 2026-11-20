import fcntl
import hashlib
import json
import os
import tempfile
import unittest
import xml.etree.ElementTree as xml
from pathlib import Path
from unittest.mock import patch

import libvirt_probe as runner


class LibvirtError(Exception):
    def get_error_code(self):
        return self.args[0]


class TestLibvirt:
    libvirtError = LibvirtError
    VIR_ERR_NO_DOMAIN = 42
    VIR_DOMAIN_START_PAUSED = 1
    VIR_DOMAIN_START_AUTODESTROY = 2
    VIR_DOMAIN_START_VALIDATE = 16
    VIR_DOMAIN_PAUSED = 3

    def __init__(self):
        self.events = []
        self.domain = None
        self.open_count = 0
        self.create_uncertain = False
        self.lookup_uncertain = False
        self.destroy_uncertain = False
        self.profile_change = lambda _document: None
        self.uri = runner.URI

    def open(self, uri):
        if uri != self.uri:
            raise AssertionError("Unexpected libvirt connection")
        self.open_count += 1
        self.events.append("open")
        return Connection(self, self.open_count)


class Connection:
    def __init__(self, libvirt, number):
        self.libvirt = libvirt
        self.number = number

    def getURI(self):
        return self.libvirt.uri

    def getDomainCapabilities(self, emulator, arch, machine, kind, flags):
        if (emulator, arch, machine, kind, flags) != (None, "x86_64", "q35", "kvm", 0):
            raise AssertionError("Unexpected request for domain capabilities")
        return "<domainCapabilities><domain>kvm</domain><arch>x86_64</arch></domainCapabilities>"

    def lookupByName(self, _name):
        return self.lookup("name")

    def lookupByUUIDString(self, _uuid):
        return self.lookup("uuid")

    def lookup(self, identity):
        self.libvirt.events.append(f"lookup-{identity}")
        if self.number == 2 and self.libvirt.lookup_uncertain:
            raise LibvirtError(99)
        if self.libvirt.domain is None:
            raise LibvirtError(self.libvirt.VIR_ERR_NO_DOMAIN)
        return self.libvirt.domain

    def createXML(self, document, flags):
        if flags != 19:
            raise AssertionError("Expected paused, autodestroy and schema validation")
        self.libvirt.events.append("create")
        domain = Domain(self.libvirt, document)
        self.libvirt.domain = domain
        if self.libvirt.create_uncertain:
            raise LibvirtError(99)
        return domain

    def close(self):
        self.libvirt.events.append("close")
        return 0


class Domain:
    def __init__(self, libvirt, document):
        self.libvirt = libvirt
        self.document = xml.fromstring(document)
        source = self.document.find("devices/disk/source")
        self.disk = Path(source.get("file"))
        source.set("index", "1")
        for channel in self.document.findall("devices/channel"):
            port = channel.find("target").get("name")
            xml.SubElement(channel, "source", mode="bind", path=f"/test/{port}.sock")
        self.document.find("os/type").set("machine", "pc-q35-8.2")
        self.libvirt.profile_change(self.document)

    def name(self):
        return self.document.findtext("name")

    def UUIDString(self):
        return self.document.findtext("uuid")

    def isPersistent(self):
        return 0

    def state(self, _flags):
        return (self.libvirt.VIR_DOMAIN_PAUSED, 0)

    def XMLDesc(self, _flags):
        self.libvirt.events.append("profile")
        return xml.tostring(self.document, encoding="unicode")

    def resume(self):
        self.libvirt.events.append("resume")

    def destroy(self):
        self.libvirt.events.append("destroy")
        if self.libvirt.destroy_uncertain:
            raise LibvirtError(99)
        self.libvirt.domain = None


class LifecycleTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name).resolve()
        self.root = path / "staging & data"
        self.root.mkdir()
        self.image = path / "base.raw"
        self.image.write_bytes(bytes(range(256)) * 2)
        self.digest = hashlib.sha256(self.image.read_bytes()).hexdigest()
        self.libvirt = TestLibvirt()
        self.cancelled = False

    def qemuAgentCommand(self, domain, command, timeout, flags):
        self.libvirt.events.append("guest-ping")
        self.assertEqual(json.loads(command), {"execute": "guest-ping"})
        self.assertEqual((timeout, flags), (2, 0))
        self.assertEqual(domain.disk.read_bytes(), self.image.read_bytes())
        return '{"return":{}}'

    def launch(self, scenario="heartbeat", session=False):
        return runner.probe(self.libvirt, self, self.root, self.image, self.digest, lambda: self.cancelled, scenario, session)

    def test_success_checks_and_destroys_before_removing_owned_disk(self):
        result = self.launch()
        self.assertEqual(result.code, "passed")
        self.assertEqual(result.imageSha256, self.digest)
        self.assertTrue(result.cleanupConfirmed)
        self.assertEqual(self.libvirt.events, [
            "open", "lookup-name", "lookup-uuid", "create", "profile", "resume", "guest-ping",
            "destroy", "close", "open", "lookup-name", "lookup-uuid", "close",
        ])
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertTrue(self.image.exists())

    def test_approved_job_channel_is_distinct_from_the_heartbeat_channel(self):
        with patch.object(runner.ProbeJob, "run", return_value="job_passed") as run:
            result = self.launch("job")
            self.assertEqual(result.code, "job_passed")
            self.assertTrue(result.cleanupConfirmed)
            run.assert_called_once()

        def share_socket(doc):
            channels = doc.findall("devices/channel/source")
            channels[1].set("path", channels[0].get("path"))

        self.libvirt.profile_change = share_socket
        self.libvirt.events.clear()
        result = self.launch("job")
        self.assertEqual(result.profileIssue, "channel-transport")
        self.assertTrue(result.cleanupConfirmed)
        self.assertNotIn("resume", self.libvirt.events)

    def test_source_is_session_only_and_rejects_an_unexpected_port_before_resume(self):
        self.assertEqual(self.launch("source").code, "config_required")
        self.assertEqual(self.libvirt.events, [])
        self.libvirt.uri = runner.SESSION_URI

        def substitute_port(document):
            target = document.find("devices/channel/target[@name='org.itervane.runner.source.0']")
            self.assertIsNotNone(target)
            target.set("name", runner.ProbeJob.port)

        self.libvirt.profile_change = substitute_port
        with (
            patch.object(runner, "prepare_session", return_value=self.root),
            patch.object(runner.SourceProbe, "run") as run,
        ):
            result = self.launch("source", session=True)
        self.assertEqual(result.code, "profile_rejected")
        self.assertEqual(result.profileIssue, "channel-target")
        self.assertTrue(result.cleanupConfirmed)
        self.assertNotIn("resume", self.libvirt.events)
        run.assert_not_called()

    def test_wrong_digest_is_rejected_before_creating_a_guest(self):
        self.digest = "0" * 64
        result = self.launch()
        self.assertEqual(result.code, "image_rejected")
        self.assertIsNone(result.imageSha256)
        self.assertNotIn("create", self.libvirt.events)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_capability_failure_records_only_the_phase_and_error_category(self):
        with patch.object(Connection, "getDomainCapabilities", side_effect=LibvirtError(7, "Permission denied in /private/runtime")):
            result = self.launch()
        self.assertEqual(result.code, "host_error")
        self.assertEqual(result.profileIssue, "capabilities-permission")
        self.assertNotIn("create", self.libvirt.events)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_symlink_is_rejected_without_reading_its_target(self):
        linked = self.image.with_name("symlink.raw")
        linked.symlink_to(self.image)
        self.image = linked
        self.assertEqual(self.launch().code, "image_rejected")
        self.assertNotIn("create", self.libvirt.events)

    def test_unexpected_domain_resource_prevents_resume(self):
        for path, attribute, value in [
            ("devices/disk/source", "file", "/other.raw"),
            ("devices/disk/driver", "type", "qcow2"),
            ("vcpu", "current", "1"),
            ("currentMemory", "unit", "MiB"),
            ("devices/channel/source", "mode", "connect"),
        ]:
            with self.subTest(path=path):
                self.libvirt.profile_change = lambda doc: doc.find(path).set(attribute, value)
                self.assertEqual(self.launch().code, "profile_rejected")
                self.assertNotIn("resume", self.libvirt.events)
        self.libvirt.profile_change = lambda doc: xml.SubElement(doc.find("devices"), "interface", type="network")
        rejected = self.launch()
        self.assertEqual(rejected.code, "profile_rejected")
        self.assertEqual(rejected.profileIssue, "device-interface")
        self.assertNotIn("resume", self.libvirt.events)
        self.assertIn("destroy", self.libvirt.events)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_q35_implicit_watchdog_requires_destroy_on_reboot(self):
        def with_watchdog(doc):
            xml.SubElement(doc.find("devices"), "watchdog", model="itco", action="reset")

        self.libvirt.profile_change = with_watchdog
        self.assertEqual(self.launch().code, "passed")

        def without_destroy(doc):
            with_watchdog(doc)
            doc.find("on_reboot").text = "restart"

        self.libvirt.profile_change = without_destroy
        self.assertEqual(self.launch().profileIssue, "lifecycle-policy")

        self.libvirt.profile_change = lambda doc: xml.SubElement(
            doc.find("devices"), "watchdog", model="itco", action="dump"
        )
        self.assertEqual(self.launch().profileIssue, "watchdog")

    def test_cancellation_after_guest_ping_still_cleans_up(self):
        normal_ping = self.qemuAgentCommand

        def started(*args):
            result = normal_ping(*args)
            self.cancelled = True
            return result

        with patch.object(self, "qemuAgentCommand", side_effect=started):
            self.assertEqual(self.launch().code, "cancelled")
        self.assertIn("destroy", self.libvirt.events)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_deadline_during_guest_ping_still_cleans_up(self):
        elapsed = 0

        def late_ping(*_args):
            nonlocal elapsed
            elapsed = runner.DEADLINE_SECONDS
            return '{"return": {}}'

        with patch.object(self, "qemuAgentCommand", side_effect=late_ping):
            with patch.object(runner.time, "monotonic", side_effect=lambda: elapsed):
                self.assertEqual(self.launch().code, "deadline_exceeded")
        self.assertIn("destroy", self.libvirt.events)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_unacknowledged_create_retains_disk_and_blocks_retry(self):
        self.libvirt.create_uncertain = True
        result = self.launch()
        self.assertEqual(result.code, "cleanup_unproven")
        directory = self.root / (runner.PREFIX + result.runId)
        self.assertEqual((directory / "disk.raw").read_bytes(), self.image.read_bytes())
        self.assertEqual(json.loads((directory / "run.json").read_text())["runId"], result.runId)
        self.assertNotIn("destroy", self.libvirt.events)
        self.assertEqual(self.launch().code, "pending_cleanup")
        self.assertEqual(self.libvirt.events.count("create"), 1)

    def test_inconclusive_destroy_or_recheck_retains_disk(self):
        for failure in ("lookup_uncertain", "destroy_uncertain"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as path:
                self.root = Path(path).resolve()
                self.libvirt = TestLibvirt()
                setattr(self.libvirt, failure, True)
                result = self.launch()
                self.assertEqual(result.code, "cleanup_unproven")
                disk = self.root / (runner.PREFIX + result.runId) / "disk.raw"
                self.assertTrue(disk.exists())

    def test_session_requires_qemu_exit_even_when_libvirt_confirms_domain_absence(self):
        self.libvirt.uri = runner.SESSION_URI
        fd = os.open(self.image, os.O_RDONLY)
        with (
            patch.object(runner, "prepare_session", return_value=self.root),
            patch.object(runner, "verify_qemu_process", return_value=fd),
            patch.object(runner, "process_exited", return_value=False),
        ):
            result = self.launch(session=True)
        self.assertIsNone(self.libvirt.domain)
        self.assertEqual(self.libvirt.open_count, 2)
        self.assertFalse(result.sessionVerified)
        self.assertEqual(result.code, "cleanup_unproven")
        self.assertTrue((self.root / (runner.PREFIX + result.runId) / "run.json").exists())
        self.assertEqual(self.launch(session=True).code, "pending_cleanup")

    def test_session_does_not_resume_a_domain_with_unproven_process_identity(self):
        self.libvirt.uri = runner.SESSION_URI
        with (
            patch.object(runner, "prepare_session", return_value=self.root),
            patch.object(runner, "verify_qemu_process", side_effect=runner.SessionRejected("qemu-process")),
        ):
            result = self.launch(session=True)
        self.assertEqual(result.code, "session_rejected")
        self.assertEqual(result.profileIssue, "qemu-process")
        self.assertNotIn("resume", self.libvirt.events)
        self.assertFalse(result.sessionVerified)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_workspace_lock_and_permissions_fail_closed(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.launch().code, "workspace_busy")
        finally:
            os.close(fd)
        self.root.chmod(0o777)
        self.assertEqual(self.launch().code, "config_required")
        self.assertEqual(self.libvirt.events, [])


if __name__ == "__main__":
    unittest.main()
