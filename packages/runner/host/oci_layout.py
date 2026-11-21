"""Verify the files referenced by an offline, single-platform OCI layout."""

import hashlib
import json
import os
import re
import stat
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path


MANIFEST = "application/vnd.oci.image.manifest.v1+json"
CONFIG = "application/vnd.oci.image.config.v1+json"
LAYER = "application/vnd.oci.image.layer.v1.tar+gzip"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
JSON_LIMIT = 64 * 1024
LAYER_LIMIT = 128 * 1024**2
TOTAL_LIMIT = 192 * 1024**2


@dataclass(frozen=True)
class Image:
    manifest_digest: str
    config_digest: str
    layer_digests: tuple[str, ...]
    config: dict


@contextmanager
def directory(path, parent=None):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        yield fd
    finally:
        os.close(fd)


@contextmanager
def regular_file(path, limit, parent=None):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(path, flags, dir_fd=parent), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= limit:
            raise ValueError("invalid OCI file")
        yield stream, info.st_size


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("duplicate OCI properties")
    return result


def parse_object(data):
    result = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object)
    if not isinstance(result, dict):
        raise ValueError("invalid OCI object")
    return result


def verify_blob(parent, descriptor, media_type, limit, *, as_json=False):
    if not isinstance(descriptor, dict):
        raise ValueError("invalid OCI descriptor")
    digest = descriptor.get("digest")
    length = descriptor.get("size")
    if (descriptor.get("mediaType") != media_type
        or not isinstance(digest, str) or not DIGEST.fullmatch(digest)
        or type(length) is not int or not 0 < length <= limit
        or "urls" in descriptor or "data" in descriptor):
        raise ValueError("invalid OCI descriptor")
    with regular_file(digest[7:], limit, parent) as (stream, size):
        if size != length:
            raise ValueError("OCI descriptor length mismatch")
        if as_json:
            data = stream.read(limit + 1)
            found = hashlib.sha256(data).hexdigest()
            if len(data) != length:
                raise ValueError("OCI JSON length mismatch")
        else:
            hasher = hashlib.sha256()
            remaining = length
            while remaining:
                chunk = stream.read(min(remaining, 1024**2))
                if not chunk:
                    raise ValueError("OCI blob truncated")
                hasher.update(chunk)
                remaining -= len(chunk)
            if stream.read(1):
                raise ValueError("OCI blob exceeded declared length")
            found = hasher.hexdigest()
    if found != digest[7:]:
        raise ValueError("OCI blob digest mismatch")
    return parse_object(data) if as_json else digest


def json_file(parent, name, limit):
    with regular_file(name, limit, parent) as (file, size):
        data = file.read(limit + 1)
    if len(data) != size:
        raise ValueError("OCI file length mismatch")
    return parse_object(data)


def verify_layout(path, expected_manifest=None):
    with (directory(path) as root, directory("blobs", root) as blobs,
          directory("sha256", blobs) as digests):
        if json_file(root, "oci-layout", 1024).get("imageLayoutVersion") != "1.0.0":
            raise ValueError("unsupported OCI layout")
        index = json_file(root, "index.json", JSON_LIMIT)
        images = index.get("manifests")
        if index.get("schemaVersion") != 2 or not isinstance(images, list) or len(images) != 1:
            raise ValueError("expected one OCI image")
        descriptor = images[0]
        manifest = verify_blob(digests, descriptor, MANIFEST, JSON_LIMIT, as_json=True)
        if expected_manifest is not None and descriptor["digest"] != expected_manifest:
            raise ValueError("OCI manifest does not match the frozen image")
        layers = manifest.get("layers")
        if (manifest.get("schemaVersion") != 2 or manifest.get("mediaType") != MANIFEST
            or "subject" in manifest or "artifactType" in manifest
            or not isinstance(layers, list) or not 1 <= len(layers) <= 8):
            raise ValueError("unsupported OCI image manifest")
        config_entry = manifest["config"]
        config = verify_blob(digests, config_entry, CONFIG, JSON_LIMIT, as_json=True)
        rootfs = config["rootfs"]
        diffs = rootfs.get("diff_ids")
        platform = descriptor.get("platform", {"os": "linux", "architecture": "amd64"})
        if (config.get("os") != "linux" or config.get("architecture") != "amd64"
            or config.get("variant") not in (None, "")
            or platform.get("os") != "linux" or platform.get("architecture") != "amd64"
            or platform.get("variant") not in (None, "")
            or rootfs.get("type") != "layers" or not isinstance(diffs, list)
            or len(diffs) != len(layers) or any(not isinstance(diff, str) or not DIGEST.fullmatch(diff) for diff in diffs)):
            raise ValueError("invalid OCI platform or rootfs")
        remaining = TOTAL_LIMIT
        layer_digests = []
        for layer in layers:
            layer_digests.append(verify_blob(digests, layer, LAYER, min(remaining, LAYER_LIMIT)))
            remaining -= layer["size"]
    return Image(descriptor["digest"], config_entry["digest"], tuple(layer_digests), config)


def verify_base(destination, upstream_digest, config_digest, layer_digest, umoci_sha256):
    base = verify_layout(destination / "base", upstream_digest)
    if (base.config_digest, base.layer_digests) != (config_digest, (layer_digest,)):
        raise ValueError("OCI conversion changed the upstream base")
    with regular_file(destination / "umoci", 10_000_000) as (stream, _):
        if hashlib.file_digest(stream, "sha256").hexdigest() != umoci_sha256:
            raise ValueError("umoci digest mismatch")
    return base


def verify_prepared_inputs(destination, expected_sha256):
    with regular_file(destination / "inputs.json", 2048) as (stream, size):
        serialized = stream.read(2049)
    if len(serialized) != size or hashlib.sha256(serialized).hexdigest() != expected_sha256:
        raise ValueError("OCI input digest mismatch")
    inputs = parse_object(serialized)
    if (inputs.get("version") != 1 or inputs.get("platform") != "linux/amd64"
        or inputs.get("baseManifestDigest") != inputs.get("upstreamManifestDigest")):
        raise ValueError("invalid OCI input receipt")
    return verify_base(destination, inputs["upstreamManifestDigest"], inputs["baseConfigDigest"],
                       inputs["baseLayerDigest"], inputs["umociSha256"])


def prepare_receipt(destination, upstream_digest, config_digest, layer_digest, umoci_sha256):
    base = verify_base(destination, upstream_digest, config_digest, layer_digest, umoci_sha256)
    inputs = {
        "version": 1, "platform": "linux/amd64", "upstreamManifestDigest": upstream_digest,
        "baseManifestDigest": base.manifest_digest, "baseConfigDigest": base.config_digest,
        "baseLayerDigest": layer_digest, "umociSha256": umoci_sha256,
    }
    serialized = json.dumps(inputs, separators=(",", ":"), sort_keys=True).encode("ascii")
    with (destination / "inputs.json").open("xb") as stream:
        stream.write(serialized)
    return {**inputs, "ociInputsSha256": hashlib.sha256(serialized).hexdigest()}


if __name__ == "__main__":
    try:
        destination, upstream, config, layer, umoci = sys.argv[1:]
        print(json.dumps(prepare_receipt(Path(destination), upstream, config, layer, umoci)))
    except (AttributeError, KeyError, OSError, RecursionError, TypeError, ValueError):
        raise SystemExit("OCI input validation failed") from None
