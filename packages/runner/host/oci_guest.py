"""Package tested runtime files and scan the same manifest in the disposable guest."""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_guest import canonical, copy_writable, directory_fd, measured_tree, read_bytes, verify_boundary
from oci_layout import regular_file, verify_layout, verify_prepared_inputs
from source_wire import MAX_OCI_ARCHIVE_BYTES, OCI_ARCHIVE_FORMAT


TOOLS = Path("/usr/local/libexec/itervane-oci")
SCANNER = Path("/usr/local/libexec/itervane-inspection")
GATE = Path("/var/lib/itervane-image-input")
WORK = Path("/var/lib/itervane-image-work")
OUTPUT = Path("/var/lib/itervane-image-output")
ARCHIVE_NAME = "image.oci.tar"
SERVICE = "itervane-image-compose.service"
NODE = SCANNER / "node"
TAR_LIMIT = 320 * 1024**2
STAMP = "1970-01-01T00:00:00Z"
APP_DIR = "opt/itervane/app"


def add_file(archive, path, name, limit, parent=None, mode=0o444):
    with regular_file(path, limit, parent) as (stream, length):
        entry = tarfile.TarInfo(name)
        entry.size = length
        entry.mode = mode
        archive.addfile(entry, stream)
    return length


def pack_runtime(project, archive_path, node=NODE):
    count = 0
    remaining = TAR_LIMIT - 16 * 1024**2

    def add_tree(archive, parent, prefix, depth):
        nonlocal count, remaining
        if depth > 30:
            raise ValueError("runtime tree depth")
        entry = tarfile.TarInfo(prefix)
        entry.type = tarfile.DIRTYPE
        entry.mode = 0o755
        archive.addfile(entry)
        for name in sorted(os.listdir(parent), key=os.fsencode):
            location = prefix + "/" + name
            count += 1
            if (count > 15_000 or len(os.fsencode(location)) > 512
                or not re.fullmatch(r"[A-Za-z0-9@._+ -]{1,180}", name) or name.startswith((".wh.", ".env"))
                or name == ".npmrc"):
                raise ValueError("unsupported runtime path")
            info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                with directory_fd(name, parent) as child:
                    add_tree(archive, child, location, depth + 1)
            elif stat.S_ISREG(info.st_mode) and info.st_size == 0 and info.st_nlink == 1:
                empty = tarfile.TarInfo(location)
                empty.mode = 0o444
                archive.addfile(empty)
            else:
                remaining -= add_file(archive, name, location, min(remaining, 16 * 1024**2), parent)

    with archive_path.open("xb") as handle, tarfile.open(fileobj=handle, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for name in ("opt", "opt/itervane", "opt/itervane/bin", APP_DIR):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)
        remaining -= add_file(archive, node, "opt/itervane/bin/node", 180 * 1024**2, mode=0o555)
        with directory_fd(project) as root:
            remaining -= add_file(archive, "package.json", APP_DIR + "/package.json", 65_536, root)
            for folder in ("dist", "node_modules", "server"):
                with directory_fd(folder, root) as tree:
                    add_tree(archive, tree, APP_DIR + "/" + folder, 0)
        os.fchmod(handle.fileno(), 0o440)


def digest_file(path, limit):
    with regular_file(path, limit) as (file, _):
        return hashlib.file_digest(file, "sha256").hexdigest()


def prepare_image(project, plan, request, profile):
    """Only the runtime supervisor can populate the image input directory."""
    layer = GATE / "runtime.tar"
    if (digest_file(project / "package.json", 65_536) != plan["packageSha256"]
        or digest_file(NODE, 180 * 1024**2) != profile["nodeSha256"]):
        raise ValueError("runtime identity")
    with (directory_fd(project) as root, directory_fd("server", root) as backend,
          directory_fd("dist", root) as dist):
        if (measured_tree(backend, 5000, 32 * 1024**2, 2 * 1024**2)["sha256"] != plan["backendSha256"]
            or measured_tree(dist, 1024, 64 * 1024**2, 8 * 1024**2, artifact=True)["sha256"] != plan["distSha256"]):
            raise ValueError("tested runtime projection")
    pack_runtime(project, layer)
    identity = {
        "ociInputsSha256": request["ociInputsSha256"], "runtimeInputsSha256": plan["runtimeInputsSha256"],
        "scannerInputsSha256": request["scannerInputsSha256"], "runtimeLayerSha256": digest_file(layer, TAR_LIMIT),
        "port": plan["port"], "version": plan["version"],
    }
    if request.get("retainStandardImage") is True:
        identity["retainStandardImage"] = True
    with (GATE / "request.json").open("xb") as output:
        output.write(canonical(identity))
        os.fchmod(output.fileno(), 0o440)
    return identity


def run(executable, args, timeout, output=False):
    result = subprocess.run(
        [executable, *args], cwd=WORK, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": str(WORK), "GOMAXPROCS": "2"},
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE if output else subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, check=True, timeout=timeout,
    )
    if output and len(result.stdout) > 1024**2:
        raise ValueError("image scan output bound")
    return result.stdout


def compose(plan, base):
    layout = WORK / "layout"
    copy_writable(TOOLS / "base", layout)
    verify_layout(layout, base.manifest_digest)
    umoci = TOOLS / "umoci"
    candidate = str(layout) + ":candidate"
    run(umoci, ["raw", "add-layer", "--image", str(layout) + ":base", "--tag", "candidate", "--compress", "gzip",
                "--history.created", STAMP, "--history.created_by", "Itervane tested runtime", GATE / "runtime.tar"], 18)
    run(umoci, ["config", "--image", candidate, "--created", STAMP, "--history.created", STAMP,
                "--clear", "config.env", "--clear", "config.entrypoint", "--clear", "config.cmd",
                "--clear", "config.labels", "--clear", "config.exposedports", "--clear", "config.volume",
                "--config.user", "10001:10001", "--config.workingdir", "/" + APP_DIR,
                "--config.entrypoint", "/opt/itervane/bin/node", "--config.cmd", "/" + APP_DIR + "/server/index.mjs",
                "--config.env", "PATH=/opt/itervane/bin:/usr/bin:/bin", "--config.env", "NODE_ENV=production",
                "--config.env", "HOST=0.0.0.0", "--config.env", f"PORT={plan['port']}",
                "--config.env", f"ITERVANE_FIXTURE_VERSION={plan['version']}", "--config.exposedports", f"{plan['port']}/tcp"], 5)
    run(umoci, ["rm", "--image", str(layout) + ":base"], 5)
    run(umoci, ["gc", "--layout", layout], 5)
    image = verify_layout(layout)
    config = image.config["config"]
    if (image.layer_digests[:-1] != base.layer_digests
        or image.config["rootfs"]["diff_ids"][-1] != "sha256:" + plan["runtimeLayerSha256"]
        or config["User"] != "10001:10001" or config["WorkingDir"] != "/" + APP_DIR
        or config["Entrypoint"] != ["/opt/itervane/bin/node"] or config["Cmd"] != ["/" + APP_DIR + "/server/index.mjs"]):
        raise ValueError("assembled image binding")
    return image


def archive_image(layout, destination, image):
    checked = verify_layout(layout, image.manifest_digest)
    digests = (checked.manifest_digest, checked.config_digest, *checked.layer_digests)
    names = ["index.json", "oci-layout", *(f"blobs/sha256/{digest[7:]}" for digest in set(digests))]
    remaining = MAX_OCI_ARCHIVE_BYTES - 32 * 1024
    with destination.open("xb") as target, tarfile.open(fileobj=target, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for name in ("blobs", "blobs/sha256"):
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            entry.mode = 0o755
            archive.addfile(entry)
        for name in sorted(names):
            remaining -= add_file(archive, layout / name, name, remaining)
        os.fchmod(target.fileno(), 0o440)
    with regular_file(destination, MAX_OCI_ARCHIVE_BYTES) as (source, size):
        return {"format": OCI_ARCHIVE_FORMAT, "sha256": hashlib.file_digest(source, "sha256").hexdigest(), "bytes": size}


def main():
    plan = json.loads(read_bytes(GATE / "request.json", 2048))
    binding = {key: plan[key] for key in ("ociInputsSha256", "runtimeInputsSha256")}
    code = "image_inputs"
    try:
        verify_boundary("itervane-image", (TOOLS, SCANNER, GATE))
        base = verify_prepared_inputs(TOOLS, plan["ociInputsSha256"])
        if digest_file(GATE / "runtime.tar", TAR_LIMIT) != plan["runtimeLayerSha256"]:
            raise ValueError("runtime layer changed")
        code = "image_compose"
        image = compose(plan, base)
        code = "image_scan"
        raw = run(NODE, [SCANNER / "worker.mjs", "image-scan", image.manifest_digest, image.config_digest,
                         plan["scannerInputsSha256"]], 30, output=True)
        scan = json.loads(raw)
        verify_layout(WORK / "layout", image.manifest_digest)
        result = {"status": "scanned", "platform": "linux/amd64", "manifestDigest": image.manifest_digest,
                  "configDigest": image.config_digest, "appLayerDigest": image.layer_digests[-1],
                  "baseManifestDigest": base.manifest_digest, "runtimeLayerSha256": plan["runtimeLayerSha256"], "scan": scan}
        if plan.get("retainStandardImage") is True:
            code = "image_compose"
            result["archive"] = archive_image(WORK / "layout", OUTPUT / ARCHIVE_NAME, image)
    except (AttributeError, OSError, KeyError, RecursionError, TypeError, ValueError, subprocess.SubprocessError):
        result = {"status": "blocked", "code": code}
    pending = OUTPUT / "receipt.pending"
    with pending.open("xb") as file:
        file.write(canonical({"version": 1, **binding, **result}))
        os.fchmod(file.fileno(), 0o440)
    pending.rename(OUTPUT / "receipt.json")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, OSError, TypeError, ValueError):
        raise SystemExit(1) from None
