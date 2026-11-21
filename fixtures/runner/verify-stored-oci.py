"""Read the manifest of the native fixture archive without extracting it."""

import hashlib
import json
import re
import sys
import tarfile
from pathlib import Path


def metadata(archive, name):
    entry = archive.getmember(name)
    if not entry.isfile() or not 0 < entry.size <= 65_536:
        raise ValueError("invalid OCI metadata entry")
    with archive.extractfile(entry) as stream:
        return stream.read(65_537)


path, expected = sys.argv[1:]
assert re.fullmatch(r"sha256:[a-f0-9]{64}", expected)
assert 0 < Path(path).stat().st_size <= 200 * 1024**2
with tarfile.open(path, "r:") as archive:
    version = json.loads(metadata(archive, "oci-layout"))
    index = json.loads(metadata(archive, "index.json"))
    assert version["imageLayoutVersion"] == "1.0.0"
    [manifest] = index["manifests"]
    content = metadata(archive, "blobs/sha256/" + expected[7:])
    observed = "sha256:" + hashlib.sha256(content).hexdigest()
    assert manifest["size"] == len(content) and manifest["digest"] == observed == expected
    assert manifest["mediaType"] == "application/vnd.oci.image.manifest.v1+json"
print(observed)
