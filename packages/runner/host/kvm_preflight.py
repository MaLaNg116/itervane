"""Collect bounded KVM capability evidence on a maintainer's Linux host."""

import errno
import fcntl
import json
import os
import platform
import stat
import sys

KVM_GET_API_VERSION = 0xAE00
KVM_CREATE_VM = 0xAE01


def check():
    if sys.platform != "linux" or platform.machine() != "x86_64":
        return "unsupported_host", None
    try:
        device = os.open("/dev/kvm", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return "device_missing", None
    except PermissionError:
        return "permission_denied", None
    except OSError:
        return "device_unavailable", None

    version = None
    try:
        if not stat.S_ISCHR(os.fstat(device).st_mode):
            return "not_a_character_device", None
        version = fcntl.ioctl(device, KVM_GET_API_VERSION, 0)
        if version != 12:
            return "unsupported_api", version
        vm = fcntl.ioctl(device, KVM_CREATE_VM, 0)
        os.close(vm)
        return "vm_descriptor_created", version
    except OSError as error:
        reason = errno.errorcode.get(error.errno, "UNKNOWN")
        return f"ioctl_{reason}", version
    finally:
        os.close(device)


def main():
    result, version = check()
    print(json.dumps({
        "schema": 1,
        "scope": "empty_kvm_vm_descriptor",
        "status": "observed" if result == "vm_descriptor_created" else "blocked",
        "result": result,
        "apiVersion": version,
        "kernel": platform.release(),
        "architecture": platform.machine(),
    }))


if __name__ == "__main__":
    main()
