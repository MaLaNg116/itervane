"""Execute the sealed build recipe and publish its bounded result inside the VM."""

import errno
import hashlib
import json
import os
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path


TOOLS = Path("/usr/local/libexec/itervane-build")
SOURCE = Path("/var/lib/itervane-build-input/ready")
WORK = Path("/var/lib/itervane-build-work")
OUTPUT = Path("/var/lib/itervane-build-output")
NODE = Path("/usr/local/libexec/itervane-inspection/node")
ACCOUNT = "itervane-build"
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
DISPATCH_DIGESTS = ("verificationInputSha256", "subjectManifestSha256", "buildProfileSha256",
                    "baselineSha256", "projectionSha256")
EXIT_CODES = {78: "boundary_denied", 79: "input_invalid", 80: "offline_install",
              81: "bundle_failed", 82: "deadline"}


def canonical(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def read_bytes(path, limit):
    with os.fdopen(os.open(path, REGULAR), "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError("invalid sealed file")
        data = file.read(limit + 1)
    if len(data) > limit:
        raise ValueError("sealed file exceeds bound")
    return data


@contextmanager
def directory_fd(path, parent=None):
    fd = os.open(path, DIRECTORY, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


def dispatch():
    request = json.loads(read_bytes(SOURCE / "request.json", 2048))
    if (not isinstance(request, dict) or request.keys() != {"version", "runId", *DISPATCH_DIGESTS}
        or type(request["version"]) is not int or request["version"] != 1
        or str(uuid.UUID(request["runId"], version=4)) != request["runId"]
        or any(not re.fullmatch(r"[a-f0-9]{64}", request[name]) for name in DISPATCH_DIGESTS)):
        raise ValueError("invalid build dispatch")
    return request


def verify_identity(account_name):
    account = pwd.getpwnam(account_name)
    if not os.getuid() == os.geteuid() == account.pw_uid > 0:
        raise ValueError("unexpected build identity")
    status = Path("/proc/self/status").read_text(encoding="ascii")
    if "NoNewPrivs:\t1\n" not in status or "CapEff:\t0000000000000000\n" not in status:
        raise ValueError("unexpected build privilege")


def verify_boundary(account_name=ACCOUNT, readonly=(SOURCE, TOOLS)):
    verify_identity(account_name)
    for path in readonly:
        if not os.statvfs(path).f_flag & os.ST_RDONLY:
            raise ValueError("mutable build input")
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            sandbox = socket.socket(family, socket.SOCK_STREAM)
        except OSError as error:
            if error.errno not in (errno.EPERM, errno.EACCES, errno.EAFNOSUPPORT):
                raise
        else:
            sandbox.close()
            raise ValueError("network socket still available")
    for path in ("/etc/itervane-probe/protected.marker", "/dev/virtio-ports/org.itervane.runner.source.0",
                 "/dev/virtio-ports/org.itervane.runner.job.0", "/var/lib/itervane-build-output"):
        try:
            fd = os.open(path, REGULAR)
        except (PermissionError, FileNotFoundError):
            continue
        os.close(fd)
        raise ValueError("protected path still available")


def measured_tree(root, max_files, max_bytes, max_file, *, artifact=False, copy_into=None):
    entries = []
    byte_count = 0
    visited = 0

    def walk(parent, prefix, depth):
        nonlocal byte_count, visited
        if depth > 24:
            raise ValueError("tree depth")
        with os.scandir(parent) as directory:
            for entry in directory:
                path = prefix + entry.name
                visited += 1
                if visited > max_files * 4 or len(path.encode("utf-8")) > 512:
                    raise ValueError("tree bound")
                if artifact and not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", entry.name):
                    raise ValueError("unsupported output name")
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    with directory_fd(entry.name, parent) as fd:
                        walk(fd, path + "/", depth + 1)
                    continue
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > max_file
                    or len(entries) >= max_files or info.st_size + byte_count > max_bytes):
                    raise ValueError("unsupported tree entry")
                with os.fdopen(os.open(entry.name, REGULAR, dir_fd=parent), "rb") as file:
                    checked = os.fstat(file.fileno())
                    if (checked.st_ino, checked.st_dev, checked.st_size) != (info.st_ino, info.st_dev, info.st_size):
                        raise ValueError("tree entry changed")
                    if copy_into is None:
                        digest = hashlib.file_digest(file, "sha256").hexdigest()
                    else:
                        data = file.read(info.st_size + 1)
                        if len(data) != info.st_size:
                            raise ValueError("tree entry changed")
                        digest = hashlib.sha256(data).hexdigest()
                        target = copy_into / path
                        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                        with target.open("xb") as copy:
                            copy.write(data)
                            os.fchmod(copy.fileno(), 0o444)
                byte_count += info.st_size
                entries.append({"path": path, "sha256": digest, "bytes": info.st_size})

    walk(root, "", 0)
    entries.sort(key=lambda item: item["path"].encode("utf-8"))
    if not entries or (artifact and (byte_count == 0 or not any(
            item["path"] == "index.html" and item["bytes"] > 0 for item in entries))):
        raise ValueError("empty build output")
    return {"sha256": hashlib.sha256(canonical(entries)).hexdigest(), "files": len(entries), "bytes": byte_count}


def copy_writable(source, target):
    shutil.copytree(source, target, symlinks=True, copy_function=shutil.copyfile)
    for directory, _, _ in os.walk(target):
        os.chmod(directory, 0o700)


def standard_env(work):
    return {"PATH": f"{TOOLS}:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(work), "CI": "true", "RAYON_NUM_THREADS": "2"}


def install_dependencies(project, cache, config, *, production=False):
    npm_args = ["--omit=dev"] if production else []
    return subprocess.run(
        [NODE, TOOLS / "npm/bin/npm-cli.js", "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
         "--no-update-notifier", "--userconfig=/dev/null", f"--globalconfig={config}", f"--cache={cache}", *npm_args],
        cwd=project, env=standard_env(config.parent), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, check=False, timeout=25,
    ).returncode


def prepare(request):
    raw = read_bytes(TOOLS / "profile.json", 4096)
    profile = json.loads(raw)
    if hashlib.sha256(raw).hexdigest() != request["buildProfileSha256"] or profile["baselineSha256"] != request["baselineSha256"]:
        raise ValueError("profile binding")
    for name, expected, limit in (
        (SOURCE / "project/package.json", profile["packageSha256"], 65_536),
        (SOURCE / "project/package-lock.json", profile["lockSha256"], 512 * 1024),
        (TOOLS / "dependencies.json", profile["dependenciesSha256"], 256 * 1024),
        (TOOLS / "baseline.mjs", profile["baselineSha256"], 65_536),
        (TOOLS / "vite.config.mjs", profile["viteConfigSha256"], 4096),
    ):
        if hashlib.sha256(read_bytes(name, limit)).hexdigest() != expected:
            raise ValueError("sealed input changed")
    with NODE.open("rb") as runtime:
        if hashlib.file_digest(runtime, "sha256").hexdigest() != profile["nodeSha256"]:
            raise ValueError("runtime binding")
    npm_version = json.loads(read_bytes(TOOLS / "npm/package.json", 65_536))["version"]
    if npm_version != profile["npmVersion"]:
        raise ValueError("npm binding")
    with directory_fd(SOURCE / "project") as root:
        if measured_tree(root, 5000, 32 * 1024 * 1024, 2 * 1024 * 1024)["sha256"] != request["projectionSha256"]:
            raise ValueError("build projection changed")
    project, cache = WORK / "project", WORK / "cache"
    # The staging mounts stay read-only. The installer owns only this copy.
    copy_writable(SOURCE / "project", project)
    copy_writable(TOOLS / "npm-cache", cache)
    return project, cache


def run():
    try:
        verify_boundary()
    except (OSError, KeyError, ValueError):
        return 78
    try:
        project, cache = prepare(dispatch())
        config = WORK / "empty.npmrc"
        config.touch(mode=0o600, exist_ok=False)
    except (OSError, KeyError, TypeError, ValueError):
        return 79

    options = {"cwd": project, "env": standard_env(WORK), "stdin": subprocess.DEVNULL,
               "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "check": False}
    try:
        if install_dependencies(project, cache, config) != 0:
            return 80
        bundled = subprocess.run(
            [NODE, project / "node_modules/vite/bin/vite.js", "build", "--config", TOOLS / "vite.config.mjs",
             "--configLoader", "native", "--logLevel", "error", "--outDir", "dist"],
            timeout=20, **options,
        )
        return 0 if bundled.returncode == 0 else 81
    except subprocess.TimeoutExpired:
        return 82
    except OSError:
        return 81


def publish():
    if os.getuid() != 0 or os.geteuid() != 0:
        return 1
    request = dispatch()
    result, status = os.environ.get("SERVICE_RESULT"), os.environ.get("EXIT_STATUS")
    if result == "success" and os.environ.get("EXIT_CODE") == "exited" and status == "0":
        try:
            # systemd has stopped the build cgroup before entering ExecStopPost.
            with (directory_fd(WORK) as work, directory_fd("project", work) as project,
                  directory_fd("dist", project) as root):
                evidence = measured_tree(root, 1024, 64 * 1024 * 1024, 8 * 1024 * 1024, artifact=True)
            proof = {**request, "status": "built", "isolationVerified": True, "dist": evidence}
        except (OSError, ValueError):
            proof = {**request, "status": "failed", "code": "output_invalid"}
    else:
        code = "bundle_failed"
        if result == "timeout":
            code = "deadline"
        elif status and status.isdecimal() and os.environ.get("EXIT_CODE") == "exited":
            code = EXIT_CODES.get(int(status), code)
        proof = {**request, "status": "failed", "code": code}
    pending = OUTPUT / "receipt.pending"
    with pending.open("xb") as receipt:
        receipt.write(canonical(proof))
        os.fchmod(receipt.fileno(), 0o440)
    pending.rename(OUTPUT / "receipt.json")
    return 0


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["run"]:
            raise SystemExit(run())
        if sys.argv[1:] == ["publish"]:
            raise SystemExit(publish())
    except (OSError, KeyError, TypeError, ValueError):
        pass
    raise SystemExit(1)
