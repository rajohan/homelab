"""Fixed file operations for the development checkout assigned by the parent chat."""
import fcntl
import hashlib
import json
import os
import secrets
import stat
import subprocess
import sys

LIMIT = 262144
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def git(*args, check=True):
    return subprocess.run(
        ["/usr/bin/git", *args], capture_output=True, text=True, check=check,
        env={"PATH": "/usr/bin:/bin", "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C"},
    )


def open_parent(root_fd, parts, create):
    directory = os.dup(root_fd)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, mode=0o755, dir_fd=directory)
                except FileExistsError:
                    pass
            child = os.open(part, DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise


def snapshot(directory, name):
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return None, None, None
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
            raise ValueError("Only regular text files up to 256 KiB can be edited.")
        data = source.read(LIMIT + 1)
        if len(data) > LIMIT or b"\0" in data:
            raise ValueError("File exceeds the limit or contains binary data.")
        return data.decode("utf-8"), hashlib.sha256(data).hexdigest(), info


def operate(req):
    root = req["checkout"]
    if not os.path.isabs(root) or os.path.realpath(root) != root:
        raise ValueError("Select the canonical directory of a development checkout.")
    root_fd = os.open(root, DIRECTORY)
    try:
        os.fchdir(root_fd)
        fcntl.flock(root_fd, fcntl.LOCK_EX if req["operation"] == "edit" else fcntl.LOCK_SH)
        if git("rev-parse", "--show-toplevel").stdout.rstrip("\n") != root:
            raise ValueError("Select the top-level directory of a Git worktree.")
        branch = git("symbolic-ref", "--short", "HEAD", check=False).stdout.strip()
        if branch in ("main", "master"):
            raise ValueError("Select a development branch or a detached worktree.")
        info = os.fstat(root_fd)
        identity = [str(info.st_dev), str(info.st_ino), branch, git("rev-parse", "--verify", "HEAD").stdout.strip()]
        if req["operation"] == "assign":
            return {"identity": identity}
        if identity != req["identity"]:
            raise ValueError("The checkout or its revision changed. Ask Mira to renew the assignment.")
        if req["operation"] == "list":
            paths = [p for p in git("ls-tree", "-rz", "--name-only", "HEAD").stdout.split("\0")
                     if p and len(p) <= 240 and req["search"].casefold() in p.casefold()]
            offset = req["offset"]
            end = min(offset + 16, len(paths))
            return {"paths": paths[offset:end], "nextOffset": end if end < len(paths) else None}
        path = req["path"]
        parts = path.split("/")
        if any(p in ("", ".", "..") or p.casefold() == ".git" for p in parts):
            raise ValueError("Expected a repository-relative source path.")
        ignored = git("check-ignore", "--quiet", "--", path, check=False)
        if ignored.returncode != 1:
            raise ValueError("Ignored or inaccessible project files cannot be delegated.")
        if req.get("trackedOnly") and git("--literal-pathspecs", "ls-files", "--error-unmatch", "--", path, check=False).returncode:
            raise ValueError("Only tracked source and explicitly assigned files are available.")
        edit = req["operation"] == "edit"
        try:
            directory = open_parent(root_fd, parts[:-1], create=edit and req["beforeSha256"] is None and req["content"] is not None)
        except FileNotFoundError:
            if edit:
                raise ValueError("The original file is missing. Read it again.")
            return {"content": None, "sha256": None, "nextOffset": None}
        try:
            name = parts[-1]
            text, digest, original = snapshot(directory, name)
            if not edit:
                start = req["offset"]
                if text is None:
                    return {"content": None, "sha256": None, "nextOffset": None}
                end = min(len(text), start + 4000)
                return {"content": text[start:end], "sha256": digest, "nextOffset": end if end < len(text) else None}
            if digest != req["beforeSha256"]:
                raise ValueError("File changed since it was read. Read it again before editing.")
            replacement = req["content"]
            if replacement is None:
                if original is None:
                    raise ValueError("File does not exist.")
                os.unlink(name, dir_fd=directory)
                return {"sha256": None, "deleted": True}
            data = replacement.encode("utf-8")
            if len(data) > LIMIT or b"\0" in data:
                raise ValueError("New content exceeds the limit or contains binary data.")
            updated = hashlib.sha256(data).hexdigest()
            if updated == digest:
                return {"sha256": digest, "changed": False}
            temporary = ".mira-edit-" + secrets.token_hex(16)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(data)
                    os.fchmod(fd, original.st_mode & 0o777 if original else 0o644)
                if original is None:
                    # Atomically refuse replacement if another editor created this file.
                    os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
                else:
                    latest = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if (latest.st_ino, latest.st_ctime_ns) != (original.st_ino, original.st_ctime_ns):
                        raise ValueError("File changed while preparing the edit.")
                    os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                try:
                    os.unlink(temporary, dir_fd=directory)
                except FileNotFoundError:
                    pass
            return {"sha256": updated, "changed": True}
        finally:
            os.close(directory)
    finally:
        os.close(root_fd)


try:
    result = operate(json.load(sys.stdin))
except (ValueError, subprocess.CalledProcessError) as error:
    result = {"error": str(error)}
print(json.dumps(result, ensure_ascii=False))
