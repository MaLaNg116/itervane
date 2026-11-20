"""Start the sealed scanner only inside its restricted guest service."""

import errno
import os
import pwd
import socket
from pathlib import Path


TOOLS = Path("/usr/local/libexec/itervane-inspection")
SOURCE = Path("/var/lib/itervane-inspection-source/ready")
OUTPUT = Path("/var/lib/itervane-inspection-output")
PORT = Path("/dev/virtio-ports/org.itervane.runner.source.0")


def verify_boundary():
    account = pwd.getpwnam("itervane-scan")
    if not os.getuid() == os.geteuid() == account.pw_uid > 0:
        raise RuntimeError()
    status = Path("/proc/self/status").read_text(encoding="ascii")
    if "NoNewPrivs:\t1\n" not in status:
        raise RuntimeError()
    for path in (SOURCE / "worktree", SOURCE / "npm", TOOLS / "policy", TOOLS / "cache"):
        if not os.statvfs(path).f_flag & os.ST_RDONLY:
            raise RuntimeError()
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            candidate = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            if error.errno not in (errno.EAFNOSUPPORT, errno.EPERM, errno.EACCES):
                raise
        else:
            candidate.close()
            raise RuntimeError()
    try:
        descriptor = os.open(PORT, os.O_RDONLY | os.O_NONBLOCK)
    except PermissionError:
        return
    os.close(descriptor)
    raise RuntimeError()


def main():
    try:
        verify_boundary()
    except (OSError, KeyError, RuntimeError):
        pending = OUTPUT / "receipt.pending"
        with pending.open("xb") as receipt:
            receipt.write(b'{"code":"scan-boundary"}')
            os.fchmod(receipt.fileno(), 0o440)
        pending.rename(OUTPUT / "receipt.json")
        return 0
    runtime = TOOLS / "node"
    os.execve(runtime, [runtime, TOOLS / "worker.mjs", "scan"], {
        "PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "ITERVANE_SCAN_BOUNDARY": "verified",
    })


if __name__ == "__main__":
    raise SystemExit(main())
