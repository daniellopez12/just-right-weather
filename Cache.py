"""Bounded cache I/O for the weather panel; stdout contains only accepted data."""

import os
import secrets
import stat
import sys

MAX_BYTES = 512 * 1024
MISSING = 3


def read_cache(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("Cache is not a regular file")
        if info.st_size > MAX_BYTES:
            raise ValueError("Cache exceeds 512 KiB")
        # Keep the read bounded even if the file grows after fstat().
        data = source.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("Cache exceeds 512 KiB")
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


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("read", "write"):
        print("Usage: Cache.py read|write PATH", file=sys.stderr)
        return 1
    operation, path = sys.argv[1:]
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
            if operation == "read":
                sys.stdout.buffer.write(read_cache(directory, name))
            else:
                write_cache(directory, name, data)
        finally:
            os.close(directory)
    except FileNotFoundError as error:
        if operation == "read":
            return MISSING
        print("Weather cache write failed: " + str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print("Weather cache " + operation + " failed: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
