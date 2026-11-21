"""Write a verified OCI layout without restoring tar ownership or permissions."""

import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
from pathlib import Path

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from oci_artifacts import Archive
from oci_layout import DIGEST, JSON_LIMIT, LAYER_LIMIT, regular_file, verify_layout
from source_wire import MAX_OCI_ARCHIVE_BYTES, OCI_ARCHIVE_FORMAT


BLOB = re.compile(r"blobs/sha256/[0-9a-f]{64}")
DIRECTORIES = {"blobs", "blobs/sha256"}
METADATA = {"index.json": JSON_LIMIT, "oci-layout": 1024}
ENTRY_LIMIT = 14


def materialize(source, destination, descriptor, manifest_digest, config_digest):
    archive = Archive.parse(descriptor)
    if not DIGEST.fullmatch(manifest_digest) or not DIGEST.fullmatch(config_digest):
        raise ValueError("invalid OCI release coordinates")
    with regular_file(source, MAX_OCI_ARCHIVE_BYTES) as (file, size):
        if size != archive.size or hashlib.file_digest(file, "sha256").hexdigest() != archive.sha256:
            raise ValueError("OCI archive differs from the frozen descriptor")
        file.seek(0)
        destination.mkdir(mode=0o700)
        (destination / "blobs").mkdir(mode=0o700)
        (destination / "blobs/sha256").mkdir(mode=0o700)
        seen = set()
        remaining = size
        with tarfile.open(fileobj=file, mode="r:") as tar:
            for entry in tar:
                name = entry.name
                if len(seen) >= ENTRY_LIMIT or name in seen or entry.pax_headers:
                    raise ValueError("unexpected OCI archive entry")
                seen.add(name)
                if entry.isdir() and name in DIRECTORIES and entry.size == 0:
                    continue
                limit = METADATA.get(name, LAYER_LIMIT if BLOB.fullmatch(name) else 0)
                if entry.type != tarfile.REGTYPE or not 0 < entry.size <= min(limit, remaining):
                    raise ValueError("unexpected OCI archive entry")
                with tar.extractfile(entry) as payload, (destination / name).open("xb") as output:
                    shutil.copyfileobj(payload, output, length=256 * 1024)
                    if output.tell() != entry.size:
                        raise ValueError("incomplete OCI archive entry")
                remaining -= entry.size
    image = verify_layout(destination, manifest_digest)
    blobs = set(f"blobs/sha256/{digest[7:]}" for digest in (image.manifest_digest, image.config_digest, *image.layer_digests))
    if image.config_digest != config_digest or (seen - DIRECTORIES) != (set(METADATA) | blobs):
        raise ValueError("OCI layout differs from the approved image")
    return {"manifestDigest": image.manifest_digest, "configDigest": image.config_digest}


if __name__ == "__main__":
    try:
        os.umask(0o077)
        archive_path, layout_path, sha256, size, manifest, config = sys.argv[1:]
        descriptor = {"format": OCI_ARCHIVE_FORMAT, "sha256": sha256, "bytes": int(size)}
        print(json.dumps(materialize(Path(archive_path), Path(layout_path), descriptor, manifest, config), separators=(",", ":")))
    except (AttributeError, KeyError, OSError, RecursionError, TypeError, ValueError, tarfile.TarError):
        print("Invalid frozen OCI layout.", file=sys.stderr)
        raise SystemExit(1) from None
