"""Trusted, fixed workload for validating the disposable guest profile."""

import errno
import os
import pwd
import resource
import socket
import subprocess
from pathlib import Path


HOST_MARKER = Path("/run/itervane-probe-private/control-plane.marker")
PROTECTED = Path("/etc/itervane-probe/protected.marker")
JOB_DEVICE = Path("/dev/virtio-ports/org.itervane.runner.job.0")
WORK = Path("/var/lib/itervane-probe-workload")
RECEIPT = Path("/run/itervane-probe-workload/ready")


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def verify_denied(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    except PermissionError:
        return
    os.close(fd)
    raise RuntimeError("protected-path-readable")


def verify_network():
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            channel = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            require(error.errno in (errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES), "network-result")
        else:
            channel.close()
            raise RuntimeError("network-family-available")


def verify_inputs():
    account = pwd.getpwnam("itervane-workload")
    require(os.getuid() == os.geteuid() == account.pw_uid > 0, "workload-identity")
    require(os.getgid() == os.getegid() == account.pw_gid, "workload-group")
    if "NoNewPrivs:\t1\n" not in Path("/proc/self/status").read_text(encoding="ascii"):
        raise RuntimeError("workload-privileges")

    try:
        HOST_MARKER.lstat()
    except FileNotFoundError:
        pass
    else:
        raise RuntimeError("host-marker-visible")
    verify_denied(PROTECTED)
    verify_denied(JOB_DEVICE)
    require(os.statvfs("/etc").f_flag & os.ST_RDONLY, "system-not-readonly")
    verify_network()

    # This lives on the writable guest disk, so a reused disk fails startup.
    with (WORK / "task.marker").open("xb") as marker:
        marker.write(b"itervane-disposable-workload\n")
        marker.flush()
        os.fsync(marker.fileno())


def verify_resources():
    cgroup = Path("/proc/self/cgroup").read_text(encoding="ascii").strip().removeprefix("0::")
    require(cgroup.startswith("/") and cgroup.endswith("/itervane-probe-workload.service"), "workload-cgroup")
    limit = Path("/sys/fs/cgroup") / cgroup.lstrip("/")
    require((limit / "memory.max").read_text().strip() == "67108864", "memory-limit")
    require((limit / "pids.max").read_text().strip() == "4", "tasks-limit")
    require(int((limit / "pids.current").read_text()) >= 2, "child-not-running")
    require(resource.getrlimit(resource.RLIMIT_FSIZE) == (65536, 65536), "file-limit")


def notify_ready():
    with RECEIPT.open("xb") as receipt:
        receipt.write(b"itervane-workload-v1\n")
        os.fchmod(receipt.fileno(), 0o644)

    address = os.environ["NOTIFY_SOCKET"]
    if address.startswith("@"):
        address = "\0" + address[1:]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notice:
        notice.sendto(b"READY=1", address)


def main():
    verify_inputs()
    with subprocess.Popen(["/usr/bin/sleep", "100"], stdin=subprocess.DEVNULL) as child:
        try:
            verify_resources()
            require(child.poll() is None, "child-not-running")
            notify_ready()
            return child.wait()
        finally:
            if child.poll() is None:
                child.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
