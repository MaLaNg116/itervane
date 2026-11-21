"""Hold the native test's retained archive aside while its replacement is read."""

import hashlib
import os
import pwd
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from oci_artifacts import Archive, ArtifactStore
from source_wire import OCI_ARCHIVE_FORMAT


def probe(directory, descriptor):
    store = ArtifactStore(directory)
    archive = Archive.parse(descriptor)
    name = archive.sha256 + ".oci.tar"
    held = ".fixture-held-" + uuid.uuid4().hex
    with store.directory() as root:
        with store.locked(root):
            store.verify(root, name, archive)
            os.rename(name, held, src_dir_fd=root, dst_dir_fd=root)
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400, dir_fd=root)
                with os.fdopen(fd, "wb") as replacement:
                    replacement.truncate(archive.size)
                with store.open_checked(root, name, archive) as replacement:
                    if hashlib.file_digest(replacement, "sha256").hexdigest() == archive.sha256:
                        raise ValueError("synthetic archive did not change")
            except BaseException:
                os.replace(held, name, src_dir_fd=root, dst_dir_fd=root)
                raise
        try:
            print("replacement_ready", flush=True)
            sys.stdin.buffer.read(1)
        finally:
            with store.locked(root):
                store.verify(root, held, archive)
                os.replace(held, name, src_dir_fd=root, dst_dir_fd=root)
                store.verify(root, name, archive)


if __name__ == "__main__":
    directory, digest, length = sys.argv[1:]
    if (not re.fullmatch(r"/var/lib/libvirt/images/itervane-native\.[A-Za-z0-9]{8}/artifacts", directory)
            or not os.geteuid() or pwd.getpwuid(os.geteuid()).pw_name != "itervane-probe"):
        raise ValueError("dedicated archive fixture required")
    probe(directory, {"format": OCI_ARCHIVE_FORMAT, "sha256": digest, "bytes": int(length)})
