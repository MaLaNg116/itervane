"""Prepare the pinned offline Semgrep CE tool directory on Ubuntu x86-64."""

import argparse
import csv
import hashlib
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve(strict=True).parent.parent
FIXTURES = ROOT / "fixtures" / "runner"
LOCK = FIXTURES / "semgrep-requirements.txt"
ENGINE_VERSION = "1.170.0"
MAX_ENGINE_FILES = 16_384
MAX_ENGINE_BYTES = 384 * 1024 * 1024


def file_digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def pip(args):
    subprocess.run([sys.executable, "-m", "pip", "--isolated", "--disable-pip-version-check", "--no-input", *args],
                   check=True, timeout=210)


def populate(directory, wheels):
    site = directory / "site"
    pip(["install", "--quiet", "--target", str(site), "--no-index", "--find-links", str(wheels),
         "--no-deps", "--no-compile", "--only-binary", ":all:", "--require-hashes", "-r", str(LOCK)])
    # Console shims embed the provisioning interpreter's path. The sealed entry uses Python directly.
    shims = site / "bin"
    if shims.is_dir() and not shims.is_symlink() and shims.resolve().parent == site.resolve():
        shutil.rmtree(shims)
        for record in site.glob("*.dist-info/RECORD"):
            with record.open(encoding="utf-8", newline="") as source:
                rows = list(csv.reader(source))
            kept = [row for row in rows if row and not row[0].startswith(("../../bin/", "bin/"))]
            if len(kept) != len(rows):
                with record.open("w", encoding="utf-8", newline="") as target:
                    csv.writer(target, lineterminator="\n").writerows(kept)
    shutil.copyfile(FIXTURES / "semgrep-entry.py", directory / "entry.py")
    directories = []
    files = []
    size = 0
    for entry in sorted(directory.rglob("*"), key=lambda path: path.relative_to(directory).as_posix()):
        if entry.is_symlink():
            raise ValueError("Unexpected symlink in Semgrep tool directory")
        if entry.is_dir():
            directories.append(entry.relative_to(directory).as_posix())
            if len(directories) > MAX_ENGINE_FILES:
                raise ValueError("Semgrep tool directory exceeds bounds")
            continue
        if not entry.is_file():
            raise ValueError("Unexpected item in Semgrep tool directory")
        info = entry.stat()
        size += info.st_size
        if size > MAX_ENGINE_BYTES or len(files) >= MAX_ENGINE_FILES:
            raise ValueError("Semgrep tool directory exceeds bounds")
        files.append({"path": entry.relative_to(directory).as_posix(), "bytes": info.st_size,
                      "sha256": file_digest(entry), "executable": bool(info.st_mode & 0o111)})
    return {"version": 1, "engine": "semgrep_ce", "engineVersion": ENGINE_VERSION, "lockSha256": file_digest(LOCK),
            "directories": directories, "files": files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--wheelhouse", type=Path)
    args = parser.parse_args()
    if sys.platform != "linux" or platform.machine() != "x86_64" or sys.version_info[:2] != (3, 12):
        raise SystemExit("Use the Linux x86-64 Python 3.12 preparation environment")
    output = args.output.absolute()
    if output.exists() or output.is_symlink() or output.parent.resolve(strict=True) != output.parent:
        raise SystemExit("Use a fresh tool output path")
    with TemporaryDirectory(prefix="itervane-ce-", dir=output.parent) as scratch:
        root = Path(scratch)
        if args.wheelhouse:
            wheels = args.wheelhouse.resolve(strict=True)
        else:
            wheels = root / "wheels"
            pip(["download", "--quiet", "--index-url", "https://pypi.org/simple", "--dest", str(wheels), "--no-deps",
                 "--only-binary", ":all:", "--require-hashes", "-r", str(LOCK)])
        staging = root / "engine"
        staging.mkdir()
        manifest = populate(staging, wheels)
        content = json.dumps(manifest, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
        (staging / "inputs.json").write_bytes(content)
        if output.exists() or output.is_symlink():
            raise ValueError("Semgrep output path became occupied")
        staging.rename(output)
    print(json.dumps({"engine": "semgrep_ce", "engineVersion": ENGINE_VERSION, "engineInputsSha256": file_digest(output / "inputs.json"),
                      "lockSha256": manifest["lockSha256"], "files": len(manifest["files"])}, separators=(",", ":")))


if __name__ == "__main__":
    main()
