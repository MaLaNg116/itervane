"""Independent pidfd observation for the disposable native CI host."""

import os
import re
import select
import sys
from pathlib import Path


controller_uid = int(sys.argv[1])
domain = sys.argv[2]
assert controller_uid > 0 and re.fullmatch(r"itervane-d2-[a-f0-9-]{36}", domain)
run_id = domain.removeprefix("itervane-d2-").encode("ascii")
pid_path = Path(f"/run/user/{controller_uid}/libvirt/qemu/run/{domain}.pid")
pid = int(pid_path.read_text(encoding="ascii"))
assert pid > 1
fd = os.pidfd_open(pid)
try:
    argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    assert os.path.basename(argv[0]) == b"qemu-system-x86_64" and (b"-uuid", run_id) in zip(argv, argv[1:])
    assert Path(f"/proc/{pid}").stat().st_uid == controller_uid
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    assert not poll.poll(0)
    print("ready", flush=True)
    assert poll.poll(25000), "The isolated guest process did not exit"
finally:
    os.close(fd)
