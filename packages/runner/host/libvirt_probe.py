"""Maintainer-only KVM lifecycle probe. No project input reaches this process."""

import errno
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
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

# The CLI starts Python in isolated mode. Only add this trusted driver directory.
if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from native_job import SCENARIOS, JobEvidence, JobRejected, ProbeJob, start_channel_events
from native_source import RuleSamplesProbe, SourceEvidence, SourceProbe, maintainer_source
from session_boundary import SESSION_URI, SessionRejected, prepare_session, process_exited, verify_qemu_process


URI = "qemu:///system"
ARCH = "x86_64"
MACHINE = "q35"
CPU_MODEL = "qemu64"
V2_FEATURES = ("cx16", "lahf_lm", "pni", "popcnt", "sse4.1", "sse4.2", "ssse3")
NESTED_VIRTUALIZATION = ("vmx", "svm")
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
    sessionVerified: bool = False
    source: SourceEvidence | None = None
    inspection: dict | None = None
    repair: dict | None = None
    ruleSamples: dict | None = None


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


def channel_names(port):
    return (GUEST_AGENT, port) if port is not None else (GUEST_AGENT,)


def domain_xml(name, run_id, disk, port=None):
    root = xml.Element("domain", type="kvm")
    xml.SubElement(root, "name").text = name
    xml.SubElement(root, "uuid").text = run_id
    xml.SubElement(root, "memory", unit="KiB").text = str(RAM_KIB)
    xml.SubElement(root, "currentMemory", unit="KiB").text = str(RAM_KIB)
    xml.SubElement(root, "vcpu", placement="static").text = str(VCPU)
    # Add only the instruction set required by the sealed tool to the portable baseline CPU.
    cpu = xml.SubElement(root, "cpu", mode="custom", match="exact", check="partial")
    xml.SubElement(cpu, "model", fallback="forbid").text = CPU_MODEL
    for feature in V2_FEATURES:
        xml.SubElement(cpu, "feature", name=feature, policy="require")
    for feature in NESTED_VIRTUALIZATION:
        xml.SubElement(cpu, "feature", name=feature, policy="disable")
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
    for target in channel_names(port):
        channel = xml.SubElement(devices, "channel", type="unix")
        xml.SubElement(channel, "target", type="virtio", name=target)
    xml.SubElement(devices, "controller", type="usb", model="none")
    xml.SubElement(devices, "memballoon", model="none")
    return xml.tostring(root, encoding="unicode")


def unexpected_tag(prefix, tags):
    first = sorted(tags)[0]
    return prefix + first if re.fullmatch(r"[a-z][a-z0-9-]{0,30}", first) else prefix + "unknown"


def profile_issue(document, disk, port=None):
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
    cpu = root.find("cpu")
    if (cpu is None or cpu.get("mode") != "custom" or cpu.get("match") != "exact" or cpu.get("check") not in ("partial", "full")
            or cpu.findtext("model") not in (CPU_MODEL, CPU_MODEL + "-v1")
            or cpu.find("model").get("fallback") != "forbid"):
        return "cpu-model"
    features = {feature.get("name"): feature.get("policy") for feature in cpu.findall("feature")}
    if (not all(features.get(name) == "require" for name in V2_FEATURES)
            or not all(features.get(name) == "disable" for name in NESTED_VIRTUALIZATION)):
        return "cpu-model"
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
    if len(volumes) != 1 or len(channels) != len(channel_names(port)):
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
    if names != set(channel_names(port)):
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


def connect(libvirt, uri=URI):
    try:
        conn = libvirt.open(uri)
    except libvirt.libvirtError as error:
        raise Rejected("libvirt_unavailable") from error
    if conn is None:
        raise Rejected("libvirt_unavailable")
    if uri == SESSION_URI:
        try:
            matches = conn.getURI() == SESSION_URI
        except libvirt.libvirtError:
            matches = False
        if not matches:
            closed(libvirt, conn)
            raise SessionRejected("session-uri")
    return conn


def closed(libvirt, conn):
    try:
        return conn.close() == 0
    except libvirt.libvirtError:
        return False


def verify_absence(libvirt, name, run_id, uri=URI):
    try:
        conn = connect(libvirt, uri)
        try:
            return absent(libvirt, conn, name, run_id)
        finally:
            closed(libvirt, conn)
    except (libvirt.libvirtError, Rejected, SessionRejected):
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


def libvirt_issue(error, phase):
    message = str(error).lower()
    if "cpu" in message and any(detail in message for detail in ("not compatible", "not supported", "does not provide", "failed to find")):
        return phase + "-cpu-incompatible"
    if "permission denied" in message:
        return phase + "-permission"
    if "too long" in message and "socket" in message:
        return phase + "-socket-path"
    if "failed to start qemu binary" in message:
        return phase + "-emulator"
    number = error.get_error_code()
    return f"{phase}-libvirt-{number}" if isinstance(number, int) and 0 <= number <= 4096 else phase + "-libvirt"


def run_guest(libvirt, qemu, root, image, digest, check_deadline, job=None, session_runtime=None):
    run_id = str(uuid.uuid4())
    name = PREFIX + run_id
    directory = root / name
    disk = directory / "disk.raw"
    journal = directory / "run.json"
    domain = None
    conn = None
    process_fd = None
    created_directory = False
    verified_image = False
    attempted_create = False
    owns_domain = False
    cleanup_confirmed = False
    process_exit_confirmed = False
    code = "host_error"
    issue = None
    job_issue = None
    phase = "connection"
    uri = SESSION_URI if session_runtime is not None else URI
    port = job.port if job else None
    try:
        check_deadline()
        conn = connect(libvirt, uri)
        phase = "capabilities"
        capabilities = xml.fromstring(conn.getDomainCapabilities(None, ARCH, MACHINE, "kvm", 0))
        if capabilities.findtext("domain") != "kvm" or capabilities.findtext("arch") != ARCH:
            raise Rejected("libvirt_unavailable")
        phase = "workspace"
        directory.mkdir(mode=0o700)
        created_directory = True
        if session_runtime is None:
            # System libvirt may run QEMU as a separate user and relabel the disk.
            directory.chmod(0o711)
        with journal.open("x", encoding="utf-8") as record:
            json.dump({"schema": 1, "runId": run_id, "domainName": name}, record)
        copy_image(image, disk, digest, check_deadline)
        verified_image = True
        phase = "domain-lookup"
        if not absent(libvirt, conn, name, run_id):
            raise Rejected("domain_conflict")
        check_deadline()
        flags = libvirt.VIR_DOMAIN_START_PAUSED | libvirt.VIR_DOMAIN_START_AUTODESTROY | libvirt.VIR_DOMAIN_START_VALIDATE
        attempted_create = True
        phase = "domain-create"
        domain = conn.createXML(domain_xml(name, run_id, disk, port), flags)
        phase = "paused-domain"
        owns_domain = (
            domain is not None
            and domain.name() == name
            and domain.UUIDString() == run_id
            and domain.isPersistent() == 0
        )
        if not owns_domain:
            issue = "domain-identity"
            raise Rejected("profile_rejected")
        if session_runtime is not None:
            process_fd = verify_qemu_process(session_runtime, name, run_id)
        if domain.state(0)[0] != libvirt.VIR_DOMAIN_PAUSED:
            issue = "domain-state"
            raise Rejected("profile_rejected")
        issue = profile_issue(domain.XMLDesc(0), disk, port)
        if issue:
            raise Rejected("profile_rejected")
        check_deadline()
        phase = "domain-resume"
        domain.resume()
        phase = "guest-heartbeat"
        ping_guest(libvirt, qemu, domain, check_deadline)
        code = "passed" if job is None else job.run(libvirt, conn, domain, run_id, check_deadline)
    except JobRejected as error:
        code = str(error)
        job_issue = job.phase
    except SessionRejected as error:
        code = "session_rejected"
        issue = str(error)
    except Rejected as error:
        code = str(error)
    except libvirt.libvirtError as error:
        code = "host_error"
        issue = libvirt_issue(error, phase)
    except OSError as error:
        code = "host_error"
        issue = f"{phase}-{errno.errorcode.get(error.errno, 'io').lower()}"
    except xml.ParseError:
        code = "host_error"
        issue = phase + "-xml"
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
        if process_fd is not None:
            try:
                process_exit_confirmed = process_exited(process_fd)
            finally:
                os.close(process_fd)
        if created_directory:
            # Keep the journal if a session domain may still have a process after libvirt loses it.
            safe_to_remove = not attempted_create or (
                owns_domain and disconnected and verify_absence(libvirt, name, run_id, uri)
                and (session_runtime is None or process_exit_confirmed)
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
    if code in ("passed", "job_passed", "source_passed", "inspection_passed", "repair_passed", "rule_samples_recorded"):
        try:
            check_deadline()
        except Rejected as error:
            code = str(error)
    return Result(
        code=code,
        runId=run_id,
        imageSha256=digest if verified_image else None,
        profileIssue=issue,
        cleanupConfirmed=cleanup_confirmed,
        job=job.evidence if isinstance(job, ProbeJob) else None,
        jobIssue=job_issue,
        sessionVerified=cleanup_confirmed and process_exit_confirmed,
        source=job.evidence if isinstance(job, SourceProbe) and code in ("source_passed", "inspection_passed", "repair_passed") else None,
        inspection=job.inspection if isinstance(job, SourceProbe) and code == "inspection_passed" else None,
        repair=job.repair if isinstance(job, SourceProbe) and code == "repair_passed" else None,
        ruleSamples=job.proof if isinstance(job, RuleSamplesProbe) and code == "rule_samples_recorded" else None,
    )


@contextmanager
def locked_workspace(root):
    if not root.is_absolute() or root.resolve(strict=True) != root:
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
        yield metadata
    finally:
        os.close(fd)


def probe(libvirt, qemu, root, image, digest, cancelled, scenario="heartbeat", session=False, *, source_override=None):
    deadline = time.monotonic() + DEADLINE_SECONDS

    def check_deadline():
        if cancelled():
            raise Rejected("cancelled")
        if time.monotonic() >= deadline:
            raise Rejected("deadline_exceeded")

    try:
        if not session and (scenario in ("source", "inspect") or source_override is not None):
            raise Rejected("config_required")
        if not image.is_absolute():
            raise Rejected("config_required")
        with locked_workspace(root):
            if any(path.name.startswith(PREFIX) for path in root.iterdir()):
                raise Rejected("pending_cleanup")
            session_runtime = prepare_session(root, image) if session else None
            if source_override is not None:
                job = source_override
            elif scenario in ("source", "inspect"):
                job = maintainer_source(inspect=scenario == "inspect")
            else:
                job = None if scenario == "heartbeat" else ProbeJob(scenario, require_workload=session)
            return run_guest(libvirt, qemu, root, image, digest, check_deadline, job, session_runtime)
    except Rejected as error:
        return Result(str(error))
    except SessionRejected as error:
        return Result("session_rejected", profileIssue=str(error))
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
        if len(sys.argv) not in (4, 5, 6) or not IMAGE_DIGEST.fullmatch(sys.argv[3]) or not all(sys.argv[1:3]):
            raise Rejected("config_required")
        scenario = sys.argv[4] if len(sys.argv) >= 5 else "heartbeat"
        mode = sys.argv[5] if len(sys.argv) == 6 else "system"
        if scenario not in (*SCENARIOS, "source", "inspect") or mode not in ("system", "session"):
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
        result = probe(libvirt, libvirt_qemu, Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], lambda: cancelled, scenario, session=mode == "session")
    except Rejected as error:
        result = Result(str(error))
    payload = asdict(result)
    # The standalone lifecycle CLI keeps its output contract. Qualified jobs use the controller protocol.
    del payload["repair"], payload["ruleSamples"]
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
