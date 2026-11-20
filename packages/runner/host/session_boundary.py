"""Local identity and process evidence for the dedicated session probe."""

import grp
import os
import pwd
import select
import stat
from pathlib import Path


SESSION_URI = "qemu:///session"
HOST_MARKER = Path("/run/itervane-probe-private/control-plane.marker")
EMPTY_CAPABILITIES = "0000000000000000"


class SessionRejected(Exception):
    pass


def process_is_unprivileged(status, uid, *, controller=True):
    fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    key, expected = ("NoNewPrivs", "1") if controller else ("CapBnd", EMPTY_CAPABILITIES)
    return (
        uid > 0
        and fields.get("Uid", "").split() == [str(uid)] * 4
        and all(fields.get(field, "").strip() == EMPTY_CAPABILITIES for field in ("CapEff", "CapPrm", "CapAmb"))
        and fields.get(key, "").strip() == expected
    )


def verify_host_marker(marker):
    proof = marker.lstat()
    if not stat.S_ISREG(proof.st_mode) or proof.st_uid != 0 or stat.S_IMODE(proof.st_mode) != 0o600 or proof.st_size < 1:
        raise SessionRejected("host-marker")
    try:
        fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except PermissionError:
        return
    os.close(fd)
    raise SessionRejected("host-marker")


def prepare_session(root, image):
    uid, gid = os.geteuid(), os.getegid()
    try:
        account = pwd.getpwuid(uid)
        kvm = grp.getgrnam("kvm").gr_gid
        own_group = grp.getgrgid(gid).gr_name == account.pw_name and account.pw_gid == gid and gid > 0
        status = Path("/proc/self/status").read_text(encoding="ascii")
    except (KeyError, OSError) as error:
        raise SessionRejected("controller-identity") from error
    if not own_group or set(os.getgroups()) - {gid, kvm} or not process_is_unprivileged(status, uid):
        raise SessionRejected("controller-identity")

    runtime = Path("/run/user") / str(uid)
    try:
        metadata = runtime.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != uid or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise SessionRejected("session-directory")
        if stat.S_IMODE(root.stat().st_mode) != 0o700:
            raise SessionRejected("session-directory")
        base = image.lstat()
        if not stat.S_ISREG(base.st_mode) or base.st_uid != 0 or base.st_mode & 0o222:
            raise SessionRejected("session-image")
    except OSError as error:
        raise SessionRejected("session-files") from error

    try:
        verify_host_marker(HOST_MARKER)
    except OSError as error:
        raise SessionRejected("host-marker") from error
    os.environ["XDG_RUNTIME_DIR"] = str(runtime)
    return runtime


def process_exited(fd, timeout=1000):
    try:
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        return any(events & select.POLLIN for _, events in poller.poll(timeout))
    except OSError:
        return False


def verify_qemu_process(runtime, name, run_id):
    if not hasattr(os, "pidfd_open"):
        raise SessionRejected("qemu-process")
    uid = os.geteuid()
    pid_path = runtime / "libvirt/qemu/run" / f"{name}.pid"
    process_fd = None
    try:
        fd = os.open(pid_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as pid_file:
            metadata = os.fstat(pid_file.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != uid:
                raise SessionRejected("qemu-process")
            value = pid_file.read(32).strip()
        if not value.isdigit() or not 1 < int(value) < 2**31:
            raise SessionRejected("qemu-process")
        pid = int(value)
        process_fd = os.pidfd_open(pid)
        proc = Path("/proc") / str(pid)
        with (proc / "cmdline").open("rb") as command:
            argv = command.read(64 * 1024).split(b"\0")
        status = (proc / "status").read_text(encoding="ascii")
        uuid_pair = (b"-uuid", run_id.encode("ascii"))
        if (
            os.path.basename(argv[0]) != b"qemu-system-x86_64"
            or uuid_pair not in zip(argv, argv[1:])
            or not process_is_unprivileged(status, uid, controller=False)
            or process_exited(process_fd, timeout=0)
        ):
            raise SessionRejected("qemu-process")
        verified_fd = process_fd
        process_fd = None
        return verified_fd
    except OSError as error:
        raise SessionRejected("qemu-process") from error
    finally:
        if process_fd is not None:
            os.close(process_fd)
