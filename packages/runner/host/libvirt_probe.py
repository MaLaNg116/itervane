"""Maintainer-only KVM lifecycle probe. No project input reaches this process."""

import fcntl
import hashlib
import json
import os
import platform
import re
import signal
import stat
import sys
import time
import uuid
import xml.etree.ElementTree as xml
from dataclasses import asdict, dataclass
from pathlib import Path

# The CLI starts Python in isolated mode. Only add this trusted driver directory.
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from guest_job import PORT as JOB_PORT
from native_job import SCENARIOS, JobEvidence, JobRejected, ProbeJob, start_channel_events


URI = "qemu:///system"
ARCH = "x86_64"
MACHINE = "q35"
VCPU = 2
RAM_KIB = 2 * 1024 * 1024
DISK_BYTES = 8 * 1024**3
DEADLINE_SECONDS = 180
KVM_GET_API_VERSION = 0xAE00
GUEST_AGENT = "org.qemu.guest_agent.0"
PREFIX = "itervane-d2-"
IMAGE_DIGEST = re.compile(r"[0-9a-f]{64}")


class Rejected(Exception):
    pass


@dataclass(frozen=True)
class Result:
    code: str
    runId: str | None = None
    imageSha256: str | None = None
    profileIssue: str | None = None
    cleanupConfirmed: bool = False
    job: JobEvidence | None = None
    jobIssue: str | None = None


def check_kvm():
    if sys.platform != "linux" or platform.machine() != ARCH:
        raise Rejected("kvm_unavailable")
    try:
        device = os.open("/dev/kvm", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISCHR(os.fstat(device).st_mode):
                raise Rejected("kvm_unavailable")
            if fcntl.ioctl(device, KVM_GET_API_VERSION, 0) != 12:
                raise Rejected("kvm_unavailable")
        finally:
            os.close(device)
    except OSError as error:
        raise Rejected("kvm_unavailable") from error


def copy_image(image, disk, expected, check_deadline):
    try:
        image_fd = os.open(image, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(image_fd, "rb") as src:
            metadata = os.fstat(src.fileno())
            size = metadata.st_size
            if not stat.S_ISREG(metadata.st_mode) or not 0 < size <= DISK_BYTES or size % 512:
                raise Rejected("image_rejected")
            digest = hashlib.sha256()
            with disk.open("xb") as dest:
                remaining = size
                while remaining:
                    check_deadline()
                    chunk = src.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise Rejected("image_rejected")
                    dest.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                if src.read(1) or digest.hexdigest() != expected:
                    raise Rejected("image_rejected")
            check_deadline()
    except OSError as error:
        raise Rejected("image_rejected") from error


def channel_names(with_job):
    return (GUEST_AGENT, JOB_PORT) if with_job else (GUEST_AGENT,)


def domain_xml(name, run_id, disk, with_job=False):
    root = xml.Element("domain", type="kvm")
    xml.SubElement(root, "name").text = name
    xml.SubElement(root, "uuid").text = run_id
    xml.SubElement(root, "memory", unit="KiB").text = str(RAM_KIB)
    xml.SubElement(root, "currentMemory", unit="KiB").text = str(RAM_KIB)
    xml.SubElement(root, "vcpu", placement="static").text = str(VCPU)
    os_config = xml.SubElement(root, "os")
    xml.SubElement(os_config, "type", arch=ARCH, machine=MACHINE).text = "hvm"
    xml.SubElement(os_config, "boot", dev="hd")
    for event in ("on_poweroff", "on_reboot", "on_crash"):
        xml.SubElement(root, event).text = "destroy"
    devices = xml.SubElement(root, "devices")
    volume = xml.SubElement(devices, "disk", type="file", device="disk")
    xml.SubElement(volume, "driver", name="qemu", type="raw")
    xml.SubElement(volume, "source", file=str(disk))
    xml.SubElement(volume, "target", dev="vda", bus="virtio")
    for target in channel_names(with_job):
        channel = xml.SubElement(devices, "channel", type="unix")
        xml.SubElement(channel, "target", type="virtio", name=target)
    xml.SubElement(devices, "controller", type="usb", model="none")
    xml.SubElement(devices, "memballoon", model="none")
    return xml.tostring(root, encoding="unicode")


def unexpected_tag(prefix, tags):
    first = sorted(tags)[0]
    return prefix + first if re.fullmatch(r"[a-z][a-z0-9-]{0,30}", first) else prefix + "unknown"


def profile_issue(document, disk, with_job=False):
    root = xml.fromstring(document)
    guest = root.find("os/type")
    vcpu = root.find("vcpu")
    if root.tag != "domain" or root.get("type") != "kvm" or guest is None or vcpu is None:
        return "domain-type"
    machine = guest.get("machine", "")
    if guest.text != "hvm" or guest.get("arch") != ARCH or not (machine == MACHINE or machine.startswith("pc-q35-")):
        return "platform"
    if vcpu.text != str(VCPU) or vcpu.get("current", str(VCPU)) != str(VCPU):
        return "vcpu"
    if any(root.findtext(event) != "destroy" for event in ("on_poweroff", "on_reboot", "on_crash")):
        return "lifecycle-policy"
    for tag in ("memory", "currentMemory"):
        element = root.find(tag)
        if element is None or element.get("unit", "KiB") != "KiB" or element.text != str(RAM_KIB):
            return "memory"
    devices = root.find("devices")
    if devices is None:
        return "no-devices"
    unexpected = {child.tag for child in devices} - {
        "emulator", "disk", "controller", "channel", "input", "audio", "memballoon", "watchdog",
    }
    if unexpected:
        return unexpected_tag("device-", unexpected)
    volumes, channels = devices.findall("disk"), devices.findall("channel")
    if root.find("maxMemory") is not None:
        return "maximum-memory"
    if len(volumes) != 1 or len(channels) != len(channel_names(with_job)):
        return "device-count"
    volume = volumes[0]
    backing = volume.find("backingStore")
    source = volume.find("source")
    # Libvirt may add an index to the active storage source.
    if volume.get("type") != "file" or volume.get("device") != "disk" or volume.find("driver[@name='qemu'][@type='raw']") is None:
        return "disk-driver"
    if source is None or source.get("file") != str(disk):
        return "disk-source"
    if set(source.attrib) - {"file", "index"}:
        return unexpected_tag("disk-attribute-", set(source.attrib) - {"file", "index"})
    if not source.get("index", "0").isdecimal():
        return "disk-index"
    if len(source):
        return unexpected_tag("disk-child-", {child.tag for child in source})
    if volume.find("target[@dev='vda'][@bus='virtio']") is None:
        return "disk-target"
    if volume.find("dataStore") is not None or (backing is not None and (backing.attrib or len(backing))):
        return "disk-backing"
    names, sockets = set(), set()
    for channel in channels:
        sources, targets = channel.findall("source"), channel.findall("target")
        if channel.get("type") != "unix" or len(sources) != 1 or sources[0].get("mode") != "bind":
            return "channel-transport"
        socket = sources[0].get("path")
        if not socket or socket in sockets:
            return "channel-transport"
        sockets.add(socket)
        if len(targets) != 1 or targets[0].get("type") != "virtio" or targets[0].get("state", "disconnected") != "disconnected":
            return "channel-target"
        names.add(targets[0].get("name"))
    if names != set(channel_names(with_job)):
        return "channel-target"
    if any(device.get("model") != "none" for device in devices.findall("controller[@type='usb']")):
        return "usb"
    if any(device.get("model") != "none" for device in devices.findall("memballoon")):
        return "balloon"
    if any(device.get("type") != "none" for device in devices.findall("audio")):
        return "audio"
    if any(device.find("source") is not None for device in devices.findall("input")):
        return "input"
    # q35 includes an iTCO watchdog in the chipset. A watchdog reset must
    # retain the domain's destroy-on-reboot policy above.
    watchdogs = devices.findall("watchdog")
    if len(watchdogs) > 1 or any(
        device.attrib != {"model": "itco", "action": "reset"}
        or any(child.tag != "alias" for child in device)
        for device in watchdogs
    ):
        return "watchdog"
    return None


def absent(libvirt, conn, name, run_id):
    # Authentication, transport and policy failures are inconclusive.
    for lookup, key in ((conn.lookupByName, name), (conn.lookupByUUIDString, run_id)):
        try:
            lookup(key)
        except libvirt.libvirtError as error:
            if error.get_error_code() != libvirt.VIR_ERR_NO_DOMAIN:
                raise
        else:
            return False
    return True


def connect(libvirt):
    try:
        conn = libvirt.open(URI)
    except libvirt.libvirtError as error:
        raise Rejected("libvirt_unavailable") from error
    if conn is None:
        raise Rejected("libvirt_unavailable")
    return conn


def closed(libvirt, conn):
    try:
        return conn.close() == 0
    except libvirt.libvirtError:
        return False


def verify_absence(libvirt, name, run_id):
    try:
        conn = connect(libvirt)
        try:
            return absent(libvirt, conn, name, run_id)
        finally:
            closed(libvirt, conn)
    except (libvirt.libvirtError, Rejected):
        return False


def ping_guest(libvirt, qemu, domain, check_deadline):
    while True:
        check_deadline()
        try:
            response = qemu.qemuAgentCommand(domain, '{"execute":"guest-ping"}', 2, 0)
        except libvirt.libvirtError:
            time.sleep(0.25)
            continue
        check_deadline()
        try:
            if len(response) <= 1024 and json.loads(response) == {"return": {}}:
                return
        except (TypeError, ValueError):
            pass
        raise Rejected("heartbeat_rejected")


def run_guest(libvirt, qemu, root, image, digest, check_deadline, job=None):
    run_id = str(uuid.uuid4())
    name = PREFIX + run_id
    directory = root / name
    disk = directory / "disk.raw"
    journal = directory / "run.json"
    domain = None
    conn = None
    created_directory = False
    verified_image = False
    attempted_create = False
    owns_domain = False
    cleanup_confirmed = False
    code = "host_error"
    issue = None
    job_issue = None
    try:
        check_deadline()
        conn = connect(libvirt)
        capabilities = xml.fromstring(conn.getDomainCapabilities(None, ARCH, MACHINE, "kvm", 0))
        if capabilities.findtext("domain") != "kvm" or capabilities.findtext("arch") != ARCH:
            raise Rejected("libvirt_unavailable")
        directory.mkdir(mode=0o700)
        created_directory = True
        # System libvirt may run QEMU as a separate user and relabel the disk.
        directory.chmod(0o711)
        with journal.open("x", encoding="utf-8") as record:
            json.dump({"schema": 1, "runId": run_id, "domainName": name}, record)
        copy_image(image, disk, digest, check_deadline)
        verified_image = True
        if not absent(libvirt, conn, name, run_id):
            raise Rejected("domain_conflict")
        check_deadline()
        flags = libvirt.VIR_DOMAIN_START_PAUSED | libvirt.VIR_DOMAIN_START_AUTODESTROY | libvirt.VIR_DOMAIN_START_VALIDATE
        attempted_create = True
        domain = conn.createXML(domain_xml(name, run_id, disk, with_job=job is not None), flags)
        owns_domain = (
            domain is not None
            and domain.name() == name
            and domain.UUIDString() == run_id
            and domain.isPersistent() == 0
        )
        if not owns_domain:
            issue = "domain-identity"
            raise Rejected("profile_rejected")
        if domain.state(0)[0] != libvirt.VIR_DOMAIN_PAUSED:
            issue = "domain-state"
            raise Rejected("profile_rejected")
        issue = profile_issue(domain.XMLDesc(0), disk, with_job=job is not None)
        if issue:
            raise Rejected("profile_rejected")
        check_deadline()
        domain.resume()
        ping_guest(libvirt, qemu, domain, check_deadline)
        code = "passed" if job is None else job.run(libvirt, conn, domain, run_id, check_deadline)
    except JobRejected as error:
        code = str(error)
        job_issue = job.phase
    except Rejected as error:
        code = str(error)
    except (libvirt.libvirtError, OSError, xml.ParseError):
        code = "host_error"
    finally:
        if owns_domain:
            try:
                domain.destroy()
            except libvirt.libvirtError:
                # Fresh identity lookups are the deciding evidence, even if
                # the explicit destroy response was lost.
                pass
        domain = None
        disconnected = conn is None or closed(libvirt, conn)
        if created_directory:
            safe_to_remove = not attempted_create or (
                owns_domain and disconnected and verify_absence(libvirt, name, run_id)
            )
            if safe_to_remove:
                try:
                    if any(path not in (disk, journal) for path in directory.iterdir()):
                        raise Rejected("cleanup_unproven")
                    disk.unlink(missing_ok=True)
                    journal.unlink(missing_ok=True)
                    directory.rmdir()
                    cleanup_confirmed = owns_domain
                except (OSError, Rejected):
                    code = "cleanup_unproven"
            else:
                code = "cleanup_unproven"
    if code in ("passed", "job_passed"):
        try:
            check_deadline()
        except Rejected as error:
            code = str(error)
    return Result(code, run_id, digest if verified_image else None, issue, cleanup_confirmed, job.evidence if job else None, job_issue)


def probe(libvirt, qemu, root, image, digest, cancelled, scenario="heartbeat"):
    deadline = time.monotonic() + DEADLINE_SECONDS

    def check_deadline():
        if cancelled():
            raise Rejected("cancelled")
        if time.monotonic() >= deadline:
            raise Rejected("deadline_exceeded")

    try:
        if not root.is_absolute() or root.resolve(strict=True) != root or not image.is_absolute():
            raise Rejected("config_required")
        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            metadata = os.fstat(fd)
            if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022:
                raise Rejected("config_required")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Rejected("workspace_busy") from error
            if any(path.name.startswith(PREFIX) for path in root.iterdir()):
                raise Rejected("pending_cleanup")
            job = None if scenario == "heartbeat" else ProbeJob(scenario)
            return run_guest(libvirt, qemu, root, image, digest, check_deadline, job)
        finally:
            os.close(fd)
    except Rejected as error:
        return Result(str(error))
    except OSError:
        return Result("config_required")


def main():
    cancelled = False

    def request_stop(_signum, _frame):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    os.umask(0o077)
    try:
        check_kvm()
        if len(sys.argv) not in (4, 5) or not IMAGE_DIGEST.fullmatch(sys.argv[3]) or not all(sys.argv[1:3]):
            raise Rejected("config_required")
        scenario = sys.argv[4] if len(sys.argv) == 5 else "heartbeat"
        if scenario not in SCENARIOS:
            raise Rejected("config_required")
        try:
            import libvirt
            import libvirt_qemu
        except ImportError as error:
            raise Rejected("libvirt_unavailable") from error
        libvirt.registerErrorHandler(lambda _ctx, _error: None, None)
        if scenario != "heartbeat":
            try:
                start_channel_events(libvirt)
            except libvirt.libvirtError as error:
                raise Rejected("libvirt_unavailable") from error
        result = probe(libvirt, libvirt_qemu, Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], lambda: cancelled, scenario)
    except Rejected as error:
        result = Result(str(error))
    print(json.dumps(asdict(result)))


if __name__ == "__main__":
    main()
