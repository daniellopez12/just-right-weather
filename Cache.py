"""Bounded weather file I/O; stdout contains only accepted data."""

import json
import os
import secrets
import stat
import sys

MAX_BYTES = 512 * 1024
LOCATION_MAX_BYTES = 16 * 1024
MANIFEST_MAX_BYTES = 16 * 1024
MISSING = 3


def read_cache(directory, name, max_bytes=MAX_BYTES):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("File is not a regular file")
        if info.st_size > max_bytes:
            raise ValueError("File exceeds " + str(max_bytes) + " bytes")
        # Keep the read bounded even if the file grows after fstat().
        data = source.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("File exceeds " + str(max_bytes) + " bytes")
        return data


def write_cache(directory, name, data):
    temporary = ".forecast-" + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "wb") as destination:
            destination.write(data)
        # Both names use the held directory, even if its path is replaced.
        # Replacing a symlink or FIFO does not open or follow its target.
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def manifest_version(data):
    manifest = json.loads(data)
    if not isinstance(manifest, dict) or manifest.get("id") != "io.github.daniellopez12.just-right-weather":
        raise ValueError("Unexpected plugin manifest")
    version = manifest.get("version")
    if not isinstance(version, str) or not 1 <= len(version) <= 64 or version != version.strip() or not version.isprintable():
        raise ValueError("Invalid plugin version")
    return version.encode("utf-8")


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("read", "read-location", "read-version", "write"):
        print("Usage: Cache.py read|read-location|read-version|write PATH", file=sys.stderr)
        return 1
    operation, path = sys.argv[1:]
    description = "Weather location read" if operation == "read-location" else "Weather cache " + operation
    if operation == "read-version":
        description = "Weather version read"
    try:
        if operation == "write":
            data = sys.stdin.buffer.read(MAX_BYTES + 1)
            if not data or len(data) > MAX_BYTES:
                raise ValueError("Cache input must contain 1 to 524288 bytes")
        parent, name = os.path.split(path)
        if operation == "write":
            os.makedirs(parent, mode=0o700, exist_ok=True)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            if operation != "write":
                max_bytes = (MANIFEST_MAX_BYTES if operation == "read-version"
                             else LOCATION_MAX_BYTES if operation == "read-location" else MAX_BYTES)
                data = read_cache(directory, name, max_bytes)
                sys.stdout.buffer.write(manifest_version(data) if operation == "read-version" else data)
            else:
                write_cache(directory, name, data)
        finally:
            os.close(directory)
    except FileNotFoundError as error:
        if operation != "write":
            return MISSING
        print("Weather cache write failed: " + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError, RecursionError) as error:
        print(description + " failed: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
