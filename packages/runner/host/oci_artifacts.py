"""Receive bounded OCI archive bytes without interpreting the archive on the host."""

import fcntl
import hashlib
import os
import re
import stat
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from source_wire import MAX_OCI_ARCHIVE_BYTES, MAX_OCI_CHUNK_BYTES, OCI_ARCHIVE_FORMAT


SHA256 = re.compile(r"[0-9a-f]{64}")
STAGING_NAME = re.compile(r"\.pending-[0-9a-f]{32}")


@dataclass(frozen=True)
class Archive:
    sha256: str
    size: int

    @classmethod
    def parse(cls, value):
        if (not isinstance(value, dict) or value.keys() != {"format", "sha256", "bytes"}
            or value["format"] != OCI_ARCHIVE_FORMAT or not isinstance(value["sha256"], str)
            or not SHA256.fullmatch(value["sha256"]) or type(value["bytes"]) is not int
            or not 0 < value["bytes"] <= MAX_OCI_ARCHIVE_BYTES):
            raise ValueError("invalid OCI archive descriptor")
        return cls(value["sha256"], value["bytes"])


@dataclass(frozen=True)
class PendingArchive:
    archive: Archive
    name: str


class ArtifactStore:
    def __init__(self, root):
        self.root = Path(root)
        if not self.root.is_absolute() or self.root == Path("/") or self.root.resolve(strict=True) != self.root:
            raise ValueError("invalid artifact store path")
        with self.directory():
            pass

    @contextmanager
    def directory(self):
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError("invalid artifact store ownership or mode")
            yield fd
        finally:
            os.close(fd)

    @staticmethod
    @contextmanager
    def locked(root):
        fd = os.open(".publication.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
                raise ValueError("invalid artifact store lock")
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    @staticmethod
    @contextmanager
    def open_checked(root, name, archive):
        with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root), "rb") as file:
            info = os.fstat(file.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid()
                or info.st_size != archive.size or stat.S_IMODE(info.st_mode) != 0o400):
                raise ValueError("stored OCI archive differs from receipt")
            yield file

    @classmethod
    def verify(cls, root, name, archive):
        with cls.open_checked(root, name, archive) as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != archive.sha256:
                raise ValueError("stored OCI archive differs from receipt")

    def stage(self, descriptor, chunks):
        archive = Archive.parse(descriptor)
        pending = PendingArchive(archive, ".pending-" + uuid.uuid4().hex)
        with self.directory() as root:
            fd = os.open(pending.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
            try:
                digest = hashlib.sha256()
                remaining = archive.size
                with os.fdopen(fd, "wb") as file:
                    for chunk in chunks:
                        if not isinstance(chunk, bytes) or not 0 < len(chunk) <= min(remaining, MAX_OCI_CHUNK_BYTES):
                            raise ValueError("invalid OCI archive frame")
                        remaining -= len(chunk)
                        digest.update(chunk)
                        file.write(chunk)
                    if remaining or digest.hexdigest() != archive.sha256:
                        raise ValueError("incomplete or modified OCI archive")
                    file.flush()
                    os.fchmod(file.fileno(), 0o400)
                    os.fsync(file.fileno())
            except BaseException:
                os.unlink(pending.name, dir_fd=root)
                raise
        return pending

    def discard(self, pending):
        if not STAGING_NAME.fullmatch(pending.name):
            raise ValueError("invalid archive stage name")
        with self.directory() as root:
            try:
                os.unlink(pending.name, dir_fd=root)
            except FileNotFoundError:
                pass

    def retain(self, pending):
        if not STAGING_NAME.fullmatch(pending.name):
            raise ValueError("invalid archive stage name")
        name = pending.archive.sha256 + ".oci.tar"
        with self.directory() as root, self.locked(root):
            self.verify(root, pending.name, pending.archive)
            try:
                self.verify(root, name, pending.archive)
            except FileNotFoundError:
                os.rename(pending.name, name, src_dir_fd=root, dst_dir_fd=root)
            else:
                os.unlink(pending.name, dir_fd=root)
            os.fsync(root)
        return pending.archive

    @contextmanager
    def open_retained(self, descriptor):
        archive = Archive.parse(descriptor)
        with self.directory() as root, self.open_checked(root, archive.sha256 + ".oci.tar", archive) as file:
            yield file

    def verify_retained(self, descriptor):
        with self.open_retained(descriptor) as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != descriptor["sha256"]:
                raise ValueError("stored OCI archive differs from receipt")
