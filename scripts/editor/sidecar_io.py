"""sidecar 的可信 dirfd I/O 边界。

所有会改变 sidecar、事务记录或 Deck 的操作，都先打开启动时记录的目录
identity，再只使用单层文件名和 ``dir_fd`` 完成。这样即使路径在校验后被替换，
也不会把数据写进替换目录。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid


class SidecarIOError(RuntimeError):
    def __init__(self, message, *, stage="open", committed=False):
        super().__init__(message)
        self.stage = stage
        self.committed = committed


def _require_name(name: str) -> str:
    if (
        not isinstance(name, str)
        or name in {"", ".", ".."}
        or os.path.basename(name) != name
        or "/" in name
        or "\\" in name
    ):
        raise SidecarIOError("I/O 文件名必须是单层相对名称")
    return name


def _require_identity(identity: dict) -> dict:
    required = {"path", "realPath", "dev", "ino"}
    if (
        not isinstance(identity, dict)
        or set(identity) != required
        or any(not isinstance(identity.get(key), str) for key in required)
    ):
        raise SidecarIOError("目录 identity 格式无效")
    return identity


def _open_directory(identity: dict) -> int:
    identity = _require_identity(identity)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(identity["path"], flags)
    except OSError as error:
        raise SidecarIOError(f"无法打开可信目录：{error}") from error
    info = os.fstat(fd)
    if (
        not stat.S_ISDIR(info.st_mode)
        or str(info.st_dev) != identity["dev"]
        or str(info.st_ino) != identity["ino"]
    ):
        os.close(fd)
        raise SidecarIOError("目录句柄 identity 与启动时不一致")
    return fd


def _read_fd_file(directory_fd: int, name: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(_require_name(name), flags, dir_fd=directory_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SidecarIOError("目标必须是非符号链接的常规文件")
        chunks = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        os.close(fd)


def read_regular(identity: dict, name: str) -> bytes:
    directory_fd = _open_directory(identity)
    try:
        return _read_fd_file(directory_fd, name)
    finally:
        os.close(directory_fd)


def atomic_write(identity: dict, name: str, contents: bytes, stage_hook=None):
    """完成 temp fsync → rename → parent fsync，成功后才返回。"""
    name = _require_name(name)
    directory_fd = _open_directory(identity)
    temporary = f".{name}.{uuid.uuid4()}.tmp"
    renamed = False
    fd = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(temporary, flags, 0o600, dir_fd=directory_fd)
        view = memoryview(contents)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
        if stage_hook:
            stage_hook("temp-fsync")
        os.close(fd)
        fd = None
        os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        renamed = True
        if stage_hook:
            stage_hook("rename")
        os.fsync(directory_fd)
        if stage_hook:
            stage_hook("directory-fsync")
        return {"committed": True}
    except Exception as error:
        stage = getattr(error, "stage", None)
        if stage is None:
            stage = "directory-fsync" if renamed else ("temp-fsync" if fd is not None else "rename")
        wrapped = SidecarIOError(str(error), stage=stage, committed=renamed)
        raise wrapped from error
    finally:
        if fd is not None:
            os.close(fd)
        if not renamed:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError:
                pass
        os.close(directory_fd)


def unlink_regular(identity: dict, name: str, *, missing_ok=False):
    name = _require_name(name)
    directory_fd = _open_directory(identity)
    try:
        try:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            if missing_ok:
                return {"removed": False}
            raise
        if not stat.S_ISREG(info.st_mode):
            raise SidecarIOError("拒绝删除非常规文件", stage="unlink")
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
        return {"removed": True}
    finally:
        os.close(directory_fd)


def ensure_child_directory(parent_identity: dict, name: str, path: str) -> dict:
    name = _require_name(name)
    parent_fd = _open_directory(parent_identity)
    child_fd = None
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        except FileExistsError:
            pass
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        child_fd = os.open(name, flags, dir_fd=parent_fd)
        info = os.fstat(child_fd)
        if not stat.S_ISDIR(info.st_mode):
            raise SidecarIOError("sidecar 子路径不是常规目录")
        absolute = str(Path(path).absolute())
        expected_path = str(Path(parent_identity["path"]) / name)
        if absolute != expected_path:
            raise SidecarIOError("sidecar 子目录路径与父 identity 不一致")
        return {
            "path": absolute,
            "realPath": str(Path(parent_identity["realPath"]) / name),
            "dev": str(info.st_dev),
            "ino": str(info.st_ino),
        }
    finally:
        if child_fd is not None:
            os.close(child_fd)
        os.close(parent_fd)


def ensure_backup(
    project_identity: dict,
    deck_name: str,
    backups_identity: dict,
    backup_name: str,
    expected_fingerprint: str,
):
    project_fd = _open_directory(project_identity)
    backups_fd = _open_directory(backups_identity)
    try:
        original = _read_fd_file(project_fd, deck_name)
        actual = hashlib.sha256(original).hexdigest()
        if actual != expected_fingerprint:
            raise SidecarIOError("Deck 指纹与保存请求基线不一致", stage="fingerprint")
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(_require_name(backup_name), flags, 0o600, dir_fd=backups_fd)
            try:
                view = memoryview(original)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(backups_fd)
        except FileExistsError:
            pass
        backup = _read_fd_file(backups_fd, backup_name)
        if backup != original or hashlib.sha256(backup).hexdigest() != expected_fingerprint:
            raise SidecarIOError("已有备份内容不一致或已损坏", stage="backup")
        return {"fingerprint": actual}
    finally:
        os.close(backups_fd)
        os.close(project_fd)


def restore_deck(
    project_identity: dict,
    deck_name: str,
    backups_identity: dict,
    backup_name: str,
    old_fingerprint: str,
    candidate_fingerprint: str,
):
    project_fd = _open_directory(project_identity)
    backups_fd = _open_directory(backups_identity)
    temporary = f".{_require_name(deck_name)}.{uuid.uuid4()}.restore.tmp"
    renamed = False
    try:
        backup = _read_fd_file(backups_fd, backup_name)
        if hashlib.sha256(backup).hexdigest() != old_fingerprint:
            raise SidecarIOError("备份指纹与写回前基线不一致", stage="restore")
        current = _read_fd_file(project_fd, deck_name)
        current_fingerprint = hashlib.sha256(current).hexdigest()
        if current_fingerprint == old_fingerprint:
            return {"restored": False, "fingerprint": old_fingerprint}
        if current_fingerprint != candidate_fingerprint:
            raise SidecarIOError(
                "Deck 已不再是本次 writer candidate，拒绝自动恢复覆盖",
                stage="restore-conflict",
            )
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(temporary, flags, 0o600, dir_fd=project_fd)
        try:
            view = memoryview(backup)
            while view:
                written = os.write(fd, view)
                view = view[written:]
            os.fsync(fd)
        finally:
            os.close(fd)
        latest = hashlib.sha256(_read_fd_file(project_fd, deck_name)).hexdigest()
        if latest != candidate_fingerprint:
            raise SidecarIOError(
                "Deck 在自动恢复期间发生外部变化，拒绝覆盖",
                stage="restore-conflict",
            )
        os.replace(temporary, deck_name, src_dir_fd=project_fd, dst_dir_fd=project_fd)
        renamed = True
        os.fsync(project_fd)
        return {"restored": True, "fingerprint": old_fingerprint}
    finally:
        if not renamed:
            try:
                os.unlink(temporary, dir_fd=project_fd)
            except FileNotFoundError:
                pass
        os.close(backups_fd)
        os.close(project_fd)


def _decode_bytes(value):
    if not isinstance(value, str):
        raise SidecarIOError("bytes 必须是 base64 字符串")
    return base64.b64decode(value, validate=True)


def dispatch(request: dict):
    operation = request.get("operation")
    if operation == "atomic-write":
        return atomic_write(
            request["directory"], request["name"], _decode_bytes(request["bytes"])
        )
    if operation == "unlink":
        return unlink_regular(
            request["directory"], request["name"], missing_ok=request.get("missingOk", False)
        )
    if operation == "read":
        return {"bytes": base64.b64encode(read_regular(request["directory"], request["name"])).decode("ascii")}
    if operation == "ensure-directory":
        return ensure_child_directory(request["parent"], request["name"], request["path"])
    if operation == "ensure-backup":
        return ensure_backup(
            request["project"], request["deckName"], request["backups"],
            request["backupName"], request["expectedFingerprint"],
        )
    if operation == "restore-deck":
        return restore_deck(
            request["project"], request["deckName"], request["backups"],
            request["backupName"], request["oldFingerprint"], request["candidateFingerprint"],
        )
    raise SidecarIOError("未知 sidecar I/O operation")


def main():
    try:
        result = dispatch(json.load(sys.stdin))
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "message": str(error),
            "stage": getattr(error, "stage", "open"),
            "committed": bool(getattr(error, "committed", False)),
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
