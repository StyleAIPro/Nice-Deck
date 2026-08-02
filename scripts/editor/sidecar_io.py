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
import re

try:
    import fcntl
except ImportError:  # pragma: no cover - 当前生产平台为 macOS/Linux
    fcntl = None


CONTROL_REQUEST_BYTES = 1024 * 1024
MAX_SESSION_BYTES = 32 * 1024 * 1024
MAX_SESSION_REQUEST_BYTES = 64 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
TRANSACTION_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


class SidecarIOError(RuntimeError):
    def __init__(
        self, message, *, stage="open", committed=False,
        commit_scope=None, code="UNSAFE_SIDECAR_IO", status_code=500,
    ):
        super().__init__(message)
        self.stage = stage
        self.committed = committed
        self.commit_scope = commit_scope
        self.code = code
        self.status_code = status_code


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


def _read_fd_file(directory_fd: int, name: str, *, max_bytes=None) -> bytes:
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
            if max_bytes is not None and sum(map(len, chunks)) > max_bytes:
                raise SidecarIOError(
                    f"文件超过 {max_bytes} 字节上限",
                    code="SIDECAR_SESSION_TOO_LARGE", status_code=413,
                )
    finally:
        os.close(fd)


def _open_child_directory(parent_fd: int, name: str, *, create: bool) -> int:
    name = _require_name(name)
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            os.fsync(parent_fd)
        except FileExistsError:
            pass
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(name, flags, dir_fd=parent_fd)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        raise SidecarIOError("sidecar 子路径不是常规目录")
    return fd


def _decode_json_file(directory_fd: int, name: str, *, max_bytes=None):
    try:
        return json.loads(_read_fd_file(directory_fd, name, max_bytes=max_bytes))
    except json.JSONDecodeError as error:
        raise SidecarIOError(f"{name} 不是有效 JSON") from error


def _atomic_write_fd(directory_fd: int, name: str, contents: bytes, *, commit_scope: str):
    """仅在持久 helper 已持有的目录 fd 内原子发布文件。"""
    if commit_scope not in {"session", "snapshot", "registry"}:
        raise SidecarIOError("原子写 commitScope 无效")
    name = _require_name(name)
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
        os.close(fd)
        fd = None
        os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        renamed = True
        os.fsync(directory_fd)
        return {"committed": True, "commitScope": commit_scope}
    except Exception as error:
        wrapped = SidecarIOError(
            str(error),
            stage=(
                f"{commit_scope}-directory-fsync"
                if renamed else f"{commit_scope}-write"
            ),
            committed=renamed,
            commit_scope=commit_scope,
            code=f"{commit_scope.upper()}_WRITE_FAILED",
        )
        raise wrapped from error
    finally:
        if fd is not None:
            os.close(fd)
        if not renamed:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except FileNotFoundError:
                pass


def _decode_bytes(value, *, max_bytes=None):
    if not isinstance(value, str):
        raise SidecarIOError("bytes 必须是 base64 字符串")
    if max_bytes is not None and len(value) > 4 * ((max_bytes + 2) // 3):
        raise SidecarIOError(
            f"bytes 解码后不得超过 {max_bytes} 字节",
            code="SIDECAR_SESSION_TOO_LARGE", status_code=413,
        )
    decoded = base64.b64decode(value, validate=True)
    if max_bytes is not None and len(decoded) > max_bytes:
        raise SidecarIOError(
            f"bytes 解码后不得超过 {max_bytes} 字节",
            code="SIDECAR_SESSION_TOO_LARGE", status_code=413,
        )
    return decoded


class PersistentHelper:
    """长期持有可信目录 fd 的生产 helper；只接受专用 JSONL 命令。"""

    def __init__(self):
        self.project_fd = None
        self.root_fd = None
        self.project_identity = None
        self.root_identity = None
        self.root_locked = False
        self.deck_name = None
        self.session_id = None
        self.session_name = None
        self.session_fd = None
        self.snapshots_fd = None
        self.backups_fd = None
        self.transactions_fd = None
        self.write_errors_fd = None

    def close(self):
        if self.root_locked and self.root_fd is not None:
            if fcntl is not None:
                fcntl.flock(self.root_fd, fcntl.LOCK_UN)
            self.root_locked = False
        for name in (
            "write_errors_fd", "transactions_fd", "backups_fd", "snapshots_fd",
            "session_fd", "root_fd", "project_fd",
        ):
            fd = getattr(self, name)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)

    def _acquire_session_lock(self):
        if fcntl is None:
            raise SidecarIOError(
                "当前平台不支持 sidecar session lock",
                code="SIDECAR_LOCK_UNSUPPORTED", status_code=500,
            )
        try:
            fcntl.flock(self.root_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SidecarIOError(
                "当前 Deck 已由另一编辑服务占用",
                stage="session-lock", code="SESSION_LOCKED", status_code=409,
            ) from error
        self.root_locked = True

    def _require_bound_session(self):
        if self.session_fd is None:
            raise SidecarIOError("尚未绑定可信 session")

    def bind_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "deckName", "sessionId", "sessionName", "create"
        }:
            raise SidecarIOError("bind-session payload 格式无效")
        if self.root_fd is None:
            raise SidecarIOError("尚未绑定可信 sidecar root")
        deck_name = _require_name(payload["deckName"])
        session_id = payload["sessionId"]
        if (
            not deck_name.endswith(".html")
            or not isinstance(session_id, str)
            or not TRANSACTION_ID_RE.fullmatch(session_id)
            or not isinstance(payload["create"], bool)
        ):
            raise SidecarIOError("bind-session 参数无效")
        session_name = _require_name(payload["sessionName"])
        expected_prefix = f"{Path(deck_name).stem}-"
        suffix = session_name.removeprefix(expected_prefix)
        if not session_name.startswith(expected_prefix) or not re.fullmatch(r"[a-f0-9]{8}", suffix):
            raise SidecarIOError("session 名称未严格绑定 Deck 和 old8")
        try:
            registry = self._validate_registry(
                json.loads(_read_fd_file(self.root_fd, "sessions.json"))
            )
        except FileNotFoundError as error:
            raise SidecarIOError("bind-session 缺少 registry") from error
        entry = registry["sessions"].get(session_id)
        deck_real_path = str(Path(self.project_identity["realPath"]) / deck_name)
        if (
            entry is None
            or entry["sessionName"] != session_name
            or entry["deckRealPath"] != deck_real_path
            or entry["status"] not in {"preparing", "active"}
            or (
                payload["create"]
                and not (entry["status"] == "preparing" and entry["mode"] == "fresh")
            )
        ):
            raise SidecarIOError("bind-session 未绑定 registry 中的当前 sessionId")

        for name in (
            "write_errors_fd", "transactions_fd", "backups_fd", "snapshots_fd", "session_fd"
        ):
            fd = getattr(self, name)
            if fd is not None:
                os.close(fd)
                setattr(self, name, None)
        self.session_fd = _open_child_directory(
            self.root_fd, session_name, create=payload["create"]
        )
        try:
            self.snapshots_fd = _open_child_directory(
                self.session_fd, "snapshots", create=payload["create"]
            )
            self.backups_fd = _open_child_directory(
                self.session_fd, "backups", create=payload["create"]
            )
            self.transactions_fd = _open_child_directory(
                self.session_fd, "transactions", create=payload["create"]
            )
            self.write_errors_fd = _open_child_directory(
                self.session_fd, "write-errors", create=payload["create"]
            )
        except Exception:
            for name in (
                "write_errors_fd", "transactions_fd", "backups_fd", "snapshots_fd", "session_fd"
            ):
                fd = getattr(self, name)
                if fd is not None:
                    os.close(fd)
                    setattr(self, name, None)
            raise
        self.deck_name = deck_name
        self.session_id = session_id
        self.session_name = session_name
        identities = {}
        for key, fd, child in (
            ("session", self.session_fd, session_name),
            ("snapshots", self.snapshots_fd, f"{session_name}/snapshots"),
            ("backups", self.backups_fd, f"{session_name}/backups"),
            ("transactions", self.transactions_fd, f"{session_name}/transactions"),
            ("writeErrors", self.write_errors_fd, f"{session_name}/write-errors"),
        ):
            identities[key] = self._identity_for_fd(
                fd,
                str(Path(self.root_identity["path"]) / child),
                str(Path(self.root_identity["realPath"]) / child),
            )
        return {"sessionName": session_name, "identities": identities}

    def read_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"missingOk"}:
            raise SidecarIOError("read-session payload 格式无效")
        self._require_bound_session()
        try:
            return _decode_json_file(
                self.session_fd, "session.json", max_bytes=MAX_SESSION_BYTES
            )
        except FileNotFoundError:
            if payload["missingOk"] is True:
                return None
            raise

    @staticmethod
    def _same_directory_entry(parent_fd, name, expected_fd):
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        held = os.fstat(expected_fd)
        return (
            stat.S_ISDIR(current.st_mode)
            and current.st_dev == held.st_dev
            and current.st_ino == held.st_ino
        )

    def assert_bound(self, payload):
        if payload != {}:
            raise SidecarIOError("assert-bound payload 格式无效")
        self._require_bound_session()
        checks = (
            (self.project_fd, ".huawei-deck-editor", self.root_fd),
            (self.root_fd, self.session_name, self.session_fd),
            (self.session_fd, "snapshots", self.snapshots_fd),
            (self.session_fd, "backups", self.backups_fd),
            (self.session_fd, "transactions", self.transactions_fd),
            (self.session_fd, "write-errors", self.write_errors_fd),
        )
        try:
            if not all(self._same_directory_entry(*check) for check in checks):
                raise SidecarIOError("sidecar 目录身份已变化")
        except OSError as error:
            raise SidecarIOError("sidecar 目录身份已变化") from error
        return {"safe": True}

    def read_transaction(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"transactionId"}:
            raise SidecarIOError("read-transaction payload 格式无效")
        self._require_bound_session()
        transaction_id = payload["transactionId"]
        if not isinstance(transaction_id, str) or not TRANSACTION_ID_RE.fullmatch(transaction_id):
            raise SidecarIOError("transactionId 不是规范 UUID v4")
        return _decode_json_file(self.transactions_fd, f"{transaction_id}.json")

    def list_transactions(self, payload):
        if payload != {}:
            raise SidecarIOError("list-transactions payload 格式无效")
        self._require_bound_session()
        transaction_ids = []
        for name in sorted(os.listdir(self.transactions_fd)):
            if not name.endswith(".json"):
                continue
            transaction_id = name[:-5]
            if not TRANSACTION_ID_RE.fullmatch(transaction_id):
                raise SidecarIOError("transactions 目录包含无效 record-like JSON")
            info = os.stat(name, dir_fd=self.transactions_fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise SidecarIOError("transaction record 必须是非符号链接的常规文件")
            transaction_ids.append(transaction_id)
        return transaction_ids

    def verify_backup(self, payload):
        if not isinstance(payload, dict) or set(payload) != {
            "backupName", "expectedFingerprint"
        }:
            raise SidecarIOError("verify-backup payload 格式无效")
        self._require_bound_session()
        fingerprint = payload["expectedFingerprint"]
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise SidecarIOError("backup fingerprint 无效")
        expected_name = f"{Path(self.deck_name).stem}-{fingerprint}.html"
        if payload["backupName"] != expected_name:
            raise SidecarIOError("backup 名称未严格绑定 Deck 指纹")
        actual = hashlib.sha256(_read_fd_file(self.backups_fd, expected_name)).hexdigest()
        if actual != fingerprint:
            raise SidecarIOError("备份指纹与写回前基线不一致")
        return {"fingerprint": actual}

    def hash_deck(self, payload):
        if payload != {}:
            raise SidecarIOError("hash-deck payload 格式无效")
        if self.deck_name is None:
            raise SidecarIOError("尚未选择 Deck")
        return {
            "fingerprint": hashlib.sha256(
                _read_fd_file(self.project_fd, self.deck_name)
            ).hexdigest()
        }

    def write_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"sessionId", "bytes"}:
            raise SidecarIOError("write-session payload 格式无效")
        self._require_bound_session()
        session_id = payload["sessionId"]
        if not isinstance(session_id, str) or not TRANSACTION_ID_RE.fullmatch(session_id):
            raise SidecarIOError("write-session sessionId 无效")
        if session_id != self.session_id:
            raise SidecarIOError("write-session sessionId 与已绑定 registry 不一致")
        contents = _decode_bytes(payload["bytes"], max_bytes=MAX_SESSION_BYTES)
        try:
            state = json.loads(contents)
        except json.JSONDecodeError as error:
            raise SidecarIOError("write-session bytes 不是有效 JSON") from error
        if not isinstance(state, dict) or state.get("sessionId") != session_id:
            raise SidecarIOError("session.json 未绑定当前 sessionId")
        return _atomic_write_fd(
            self.session_fd, "session.json", contents, commit_scope="session"
        )

    @staticmethod
    def _unlink_bound(directory_fd, name):
        name = _require_name(name)
        try:
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            return {"removed": False}
        if not stat.S_ISREG(info.st_mode):
            raise SidecarIOError("拒绝删除非常规文件", stage="unlink")
        os.unlink(name, dir_fd=directory_fd)
        os.fsync(directory_fd)
        return {"removed": True}

    def write_snapshot(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"snapshotId", "bytes"}:
            raise SidecarIOError("write-snapshot payload 格式无效")
        self._require_bound_session()
        snapshot_id = payload["snapshotId"]
        if not isinstance(snapshot_id, str) or not TRANSACTION_ID_RE.fullmatch(snapshot_id):
            raise SidecarIOError("snapshotId 不是规范 UUID v4")
        return _atomic_write_fd(
            self.snapshots_fd,
            f"{snapshot_id}.png",
            _decode_bytes(payload["bytes"]),
            commit_scope="snapshot",
        )

    def delete_snapshot(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"snapshotId"}:
            raise SidecarIOError("delete-snapshot payload 格式无效")
        self._require_bound_session()
        snapshot_id = payload["snapshotId"]
        if not isinstance(snapshot_id, str) or not TRANSACTION_ID_RE.fullmatch(snapshot_id):
            raise SidecarIOError("snapshotId 不是规范 UUID v4")
        return self._unlink_bound(self.snapshots_fd, f"{snapshot_id}.png")

    def delete_transaction(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"transactionId"}:
            raise SidecarIOError("delete-transaction payload 格式无效")
        self._require_bound_session()
        transaction_id = payload["transactionId"]
        if not isinstance(transaction_id, str) or not TRANSACTION_ID_RE.fullmatch(transaction_id):
            raise SidecarIOError("transactionId 不是规范 UUID v4")
        return self._unlink_bound(self.transactions_fd, f"{transaction_id}.json")

    def prune_transactions(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"maximum"}:
            raise SidecarIOError("prune-transactions payload 格式无效")
        maximum = payload["maximum"]
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 0 <= maximum <= 256:
            raise SidecarIOError("prune-transactions maximum 无效")
        self._require_bound_session()
        candidates = []
        for name in os.listdir(self.transactions_fd):
            if not name.endswith(".json"):
                continue
            if not TRANSACTION_ID_RE.fullmatch(name[:-5]):
                raise SidecarIOError("transactions 目录包含无效 record-like JSON")
            info = os.stat(name, dir_fd=self.transactions_fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise SidecarIOError("transaction record 必须是常规文件")
            candidates.append((info.st_mtime_ns, name))
        candidates.sort(reverse=True)
        removed = 0
        for _, name in candidates[maximum:]:
            self._unlink_bound(self.transactions_fd, name)
            removed += 1
        return {"removed": removed}

    def restore_bound_deck(self, payload):
        required = {"backupName", "oldFingerprint", "candidateFingerprint"}
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("restore-deck payload 格式无效")
        self._require_bound_session()
        old_fingerprint = payload["oldFingerprint"]
        candidate_fingerprint = payload["candidateFingerprint"]
        if (
            not isinstance(old_fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", old_fingerprint)
            or not isinstance(candidate_fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", candidate_fingerprint)
            or payload["backupName"]
            != f"{Path(self.deck_name).stem}-{old_fingerprint}.html"
        ):
            raise SidecarIOError("restore-deck 参数未绑定 Deck/fingerprint")
        backup = _read_fd_file(self.backups_fd, payload["backupName"])
        if hashlib.sha256(backup).hexdigest() != old_fingerprint:
            raise SidecarIOError("备份指纹与写回前基线不一致", stage="restore")
        current = _read_fd_file(self.project_fd, self.deck_name)
        current_fingerprint = hashlib.sha256(current).hexdigest()
        if current_fingerprint == old_fingerprint:
            return {"restored": False, "fingerprint": old_fingerprint}
        if current_fingerprint != candidate_fingerprint:
            raise SidecarIOError(
                "Deck 已不再是本次 writer candidate，拒绝自动恢复覆盖",
                stage="restore-conflict",
            )
        temporary = f".{self.deck_name}.{uuid.uuid4()}.restore.tmp"
        renamed = False
        try:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(temporary, flags, 0o600, dir_fd=self.project_fd)
            try:
                view = memoryview(backup)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
                os.fsync(fd)
            finally:
                os.close(fd)
            latest = hashlib.sha256(
                _read_fd_file(self.project_fd, self.deck_name)
            ).hexdigest()
            if latest != candidate_fingerprint:
                raise SidecarIOError(
                    "Deck 在自动恢复期间发生外部变化，拒绝覆盖",
                    stage="restore-conflict",
                )
            os.replace(
                temporary, self.deck_name,
                src_dir_fd=self.project_fd, dst_dir_fd=self.project_fd,
            )
            renamed = True
            os.fsync(self.project_fd)
            return {"restored": True, "fingerprint": old_fingerprint}
        finally:
            if not renamed:
                try:
                    os.unlink(temporary, dir_fd=self.project_fd)
                except FileNotFoundError:
                    pass

    def initialize(self, payload):
        if not isinstance(payload, dict) or set(payload) not in (
            {"project"}, {"project", "root"}
        ):
            raise SidecarIOError("initialize payload 格式无效")
        self.project_identity = _require_identity(payload["project"])
        self.project_fd = _open_directory(self.project_identity)
        if "root" in payload:
            self.root_identity = _require_identity(payload["root"])
            self.root_fd = _open_directory(self.root_identity)
        else:
            root_name = ".huawei-deck-editor"
            try:
                os.mkdir(root_name, 0o700, dir_fd=self.project_fd)
                os.fsync(self.project_fd)
            except FileExistsError:
                pass
            self.root_fd = _open_child_directory(
                self.project_fd, root_name, create=False
            )
            self.root_identity = self._identity_for_fd(
                self.root_fd,
                str(Path(self.project_identity["path"]) / root_name),
                str(Path(self.project_identity["realPath"]) / root_name),
            )
        self._acquire_session_lock()
        return {"ready": True, "root": self.root_identity}

    @staticmethod
    def _identity_for_fd(fd, path, real_path):
        info = os.fstat(fd)
        return {
            "path": path,
            "realPath": real_path,
            "dev": str(info.st_dev),
            "ino": str(info.st_ino),
        }

    def ensure_root(self, payload):
        if payload != {} or self.project_fd is None or self.root_fd is None:
            raise SidecarIOError("ensure-root 状态或 payload 无效")
        return {"created": False, "identity": self.root_identity}

    def discover(self, payload):
        if (
            self.root_fd is None
            or not isinstance(payload, dict)
            or set(payload) != {"deckName"}
        ):
            raise SidecarIOError("discover payload 格式无效")
        deck_name = _require_name(payload["deckName"])
        if not deck_name.endswith(".html"):
            raise SidecarIOError("discover deckName 无效")
        self.deck_name = deck_name
        registry = None
        try:
            registry = self._validate_registry(
                json.loads(_read_fd_file(self.root_fd, "sessions.json"))
            )
        except FileNotFoundError:
            pass
        if registry is None:
            return {"registry": None, "sessions": []}
        deck_real_path = str(Path(self.project_identity["realPath"]) / deck_name)
        sessions = []
        for session_id, entry in sorted(registry["sessions"].items()):
            if entry["deckRealPath"] != deck_real_path:
                continue
            try:
                info = os.stat(
                    entry["sessionName"], dir_fd=self.root_fd, follow_symlinks=False
                )
                kind = "directory" if stat.S_ISDIR(info.st_mode) else "unsafe"
            except FileNotFoundError:
                kind = "missing"
            sessions.append({**entry, "kind": kind})
        return {"registry": registry, "sessions": sessions}

    def inspect_legacy(self, payload):
        if (
            self.root_fd is None
            or not isinstance(payload, dict)
            or set(payload) != {"deckName", "currentFingerprint"}
        ):
            raise SidecarIOError("inspect-legacy payload 格式无效")
        deck_name = _require_name(payload["deckName"])
        fingerprint = payload["currentFingerprint"]
        if (
            not deck_name.endswith(".html")
            or not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
        ):
            raise SidecarIOError("inspect-legacy 参数无效")
        prefix = f"{Path(deck_name).stem}-"
        candidates = []
        for session_name in sorted(os.listdir(self.root_fd)):
            if not session_name.startswith(prefix):
                continue
            info = os.stat(session_name, dir_fd=self.root_fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                raise SidecarIOError("legacy session 候选必须是真实目录")
            session_fd = _open_child_directory(self.root_fd, session_name, create=False)
            transactions_fd = None
            try:
                transactions_fd = _open_child_directory(
                    session_fd, "transactions", create=False
                )
                transaction_ids = []
                for name in sorted(os.listdir(transactions_fd)):
                    if not name.endswith(".json"):
                        continue
                    transaction_id = name[:-5]
                    if not TRANSACTION_ID_RE.fullmatch(transaction_id):
                        raise SidecarIOError("legacy transaction 名称无效")
                    transaction_info = os.stat(
                        name, dir_fd=transactions_fd, follow_symlinks=False
                    )
                    if not stat.S_ISREG(transaction_info.st_mode):
                        raise SidecarIOError("legacy transaction 必须是常规文件")
                    transaction_ids.append(transaction_id)
                candidates.append({
                    "sessionName": session_name,
                    "expectedCurrentName": (
                        session_name == f"{Path(deck_name).stem}-{fingerprint[:8]}"
                    ),
                    "transactionIds": transaction_ids,
                    "sessionState": _decode_json_file(
                        session_fd, "session.json", max_bytes=MAX_SESSION_BYTES
                    ),
                })
            finally:
                if transactions_fd is not None:
                    os.close(transactions_fd)
                os.close(session_fd)
        return {"candidates": candidates}

    def _validate_registry(self, registry):
        if (
            not isinstance(registry, dict)
            or set(registry) != {"version", "sessions"}
            or registry["version"] != 1
            or not isinstance(registry["sessions"], dict)
        ):
            raise SidecarIOError("sessions.json schema 无效")
        normalized = {"version": 1, "sessions": {}}
        for session_id, entry in registry["sessions"].items():
            if (
                not isinstance(session_id, str)
                or not TRANSACTION_ID_RE.fullmatch(session_id)
                or not isinstance(entry, dict)
                or set(entry) != {
                    "sessionId", "deckRealPath", "initialFingerprint", "sessionName",
                    "mode", "status",
                }
                or entry.get("sessionId") != session_id
                or not isinstance(entry.get("deckRealPath"), str)
                or not isinstance(entry.get("initialFingerprint"), str)
                or not re.fullmatch(r"[a-f0-9]{64}", entry["initialFingerprint"])
                or not isinstance(entry.get("sessionName"), str)
                or entry.get("mode") not in {"fresh", "legacy"}
                or entry.get("status") not in {"preparing", "active"}
            ):
                raise SidecarIOError("sessions.json session 记录无效")
            expected_name = (
                f"{Path(entry['deckRealPath']).stem}-{entry['initialFingerprint'][:8]}"
            )
            if entry["sessionName"] != expected_name:
                raise SidecarIOError("registry sessionName 未绑定 initialFingerprint")
            normalized["sessions"][session_id] = dict(entry)
        return normalized

    def prepare_session(self, payload):
        required = {
            "deckName", "sessionId", "initialFingerprint", "sessionName", "mode"
        }
        if not isinstance(payload, dict) or set(payload) != required:
            raise SidecarIOError("prepare-session payload 格式无效")
        if self.root_fd is None:
            raise SidecarIOError("尚未绑定可信 sidecar root")
        deck_name = _require_name(payload["deckName"])
        session_id = payload["sessionId"]
        fingerprint = payload["initialFingerprint"]
        session_name = _require_name(payload["sessionName"])
        mode = payload["mode"]
        if (
            not deck_name.endswith(".html")
            or not isinstance(session_id, str)
            or not TRANSACTION_ID_RE.fullmatch(session_id)
            or not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
            or session_name != f"{Path(deck_name).stem}-{fingerprint[:8]}"
            or mode not in {"fresh", "legacy"}
        ):
            raise SidecarIOError("prepare-session 参数未严格绑定 Deck/session")
        try:
            registry = self._validate_registry(
                json.loads(_read_fd_file(self.root_fd, "sessions.json"))
            )
        except FileNotFoundError:
            registry = {"version": 1, "sessions": {}}
        deck_real_path = str(Path(self.project_identity["realPath"]) / deck_name)
        entry = {
            "sessionId": session_id,
            "deckRealPath": deck_real_path,
            "initialFingerprint": fingerprint,
            "sessionName": session_name,
            "mode": mode,
            "status": "preparing",
        }
        existing = registry["sessions"].get(session_id)
        if existing is not None and existing != entry:
            raise SidecarIOError("sessionId 已绑定其他 session")
        for other_id, other in registry["sessions"].items():
            if other_id != session_id and other["sessionName"] == session_name:
                raise SidecarIOError("session 目录已绑定其他 sessionId")
        registry["sessions"][session_id] = entry
        _atomic_write_fd(
            self.root_fd,
            "sessions.json",
            json.dumps(registry, ensure_ascii=False, indent=2).encode("utf-8"),
            commit_scope="registry",
        )
        return entry

    def activate_session(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"sessionId"}:
            raise SidecarIOError("activate-session payload 格式无效")
        self._require_bound_session()
        session_id = payload["sessionId"]
        if not isinstance(session_id, str) or not TRANSACTION_ID_RE.fullmatch(session_id):
            raise SidecarIOError("activate-session sessionId 无效")
        registry = self._validate_registry(
            json.loads(_read_fd_file(self.root_fd, "sessions.json"))
        )
        entry = registry["sessions"].get(session_id)
        if (
            entry is None
            or entry["sessionName"] != self.session_name
            or entry["status"] not in {"preparing", "active"}
        ):
            raise SidecarIOError("activate-session 未绑定当前 preparing session")
        state = _decode_json_file(self.session_fd, "session.json")
        if (
            not isinstance(state, dict)
            or state.get("sessionId") != session_id
            or os.path.realpath(str(state.get("deckPath", ""))) != entry["deckRealPath"]
            or state.get("deckFingerprint") != entry["initialFingerprint"]
        ):
            raise SidecarIOError("session.json 未严格绑定 preparing registry")
        if entry["status"] == "active":
            return entry
        active = {**entry, "status": "active"}
        registry["sessions"][session_id] = active
        _atomic_write_fd(
            self.root_fd,
            "sessions.json",
            json.dumps(registry, ensure_ascii=False, indent=2).encode("utf-8"),
            commit_scope="registry",
        )
        return active

    def dispatch(self, request):
        if not isinstance(request, dict) or set(request) != {"id", "command", "payload"}:
            raise SidecarIOError("helper request schema 无效")
        command = request["command"]
        if command == "initialize":
            return self.initialize(request["payload"])
        if command == "ensure-root":
            return self.ensure_root(request["payload"])
        if command == "discover":
            return self.discover(request["payload"])
        if command == "inspect-legacy":
            return self.inspect_legacy(request["payload"])
        if command == "prepare-session":
            return self.prepare_session(request["payload"])
        if command == "activate-session":
            return self.activate_session(request["payload"])
        if command == "bind-session":
            return self.bind_session(request["payload"])
        if command == "read-session":
            return self.read_session(request["payload"])
        if command == "assert-bound":
            return self.assert_bound(request["payload"])
        if command == "read-transaction":
            return self.read_transaction(request["payload"])
        if command == "list-transactions":
            return self.list_transactions(request["payload"])
        if command == "verify-backup":
            return self.verify_backup(request["payload"])
        if command == "hash-deck":
            return self.hash_deck(request["payload"])
        if command == "write-session":
            return self.write_session(request["payload"])
        if command == "write-snapshot":
            return self.write_snapshot(request["payload"])
        if command == "delete-snapshot":
            return self.delete_snapshot(request["payload"])
        if command == "delete-transaction":
            return self.delete_transaction(request["payload"])
        if command == "prune-transactions":
            return self.prune_transactions(request["payload"])
        if command == "restore-deck":
            return self.restore_bound_deck(request["payload"])
        if command == "close":
            if request["payload"] != {}:
                raise SidecarIOError("close payload 格式无效")
            return {"closed": True}
        raise SidecarIOError("未知 persistent helper command")


def serve():
    helper = PersistentHelper()
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_SESSION_REQUEST_BYTES + 1)
            if not line:
                return
            if len(line) > MAX_SESSION_REQUEST_BYTES or not line.endswith(b"\n"):
                raise SidecarIOError("helper 输入超过上限")
            request = None
            try:
                request = json.loads(line)
                command = request.get("command") if isinstance(request, dict) else None
                request_limit = (
                    MAX_SESSION_REQUEST_BYTES
                    if command == "write-session"
                    else CONTROL_REQUEST_BYTES
                )
                if len(line) > request_limit:
                    raise SidecarIOError(
                        "helper 控制命令输入超过上限",
                        code="SIDECAR_HELPER_INPUT_LIMIT", status_code=413,
                    )
                result = helper.dispatch(request)
                response = {"id": request["id"], "ok": True, "result": result}
            except Exception as error:
                response = {
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False,
                    "message": str(error),
                    "code": getattr(error, "code", "UNSAFE_SIDECAR_IO"),
                    "statusCode": getattr(error, "status_code", 500),
                    "stage": getattr(error, "stage", "sidecar"),
                    "committed": bool(getattr(error, "committed", False)),
                    "commitScope": getattr(error, "commit_scope", None),
                }
            encoded = (json.dumps(response, ensure_ascii=False) + "\n").encode("utf-8")
            response_limit = (
                MAX_RESPONSE_BYTES
                if isinstance(request, dict) and request.get("command") == "read-session"
                else CONTROL_REQUEST_BYTES
            )
            if len(encoded) > response_limit:
                encoded = (json.dumps({
                    "id": request.get("id") if isinstance(request, dict) else None,
                    "ok": False,
                    "message": "helper 输出超过命令上限",
                    "code": "SIDECAR_HELPER_OUTPUT_LIMIT",
                    "statusCode": 500,
                    "stage": "sidecar",
                    "committed": False,
                }, ensure_ascii=False) + "\n").encode("utf-8")
            sys.stdout.buffer.write(encoded)
            sys.stdout.buffer.flush()
            if isinstance(request, dict) and request.get("command") == "close":
                return
    finally:
        helper.close()


if __name__ == "__main__":
    if sys.argv[1:] != ["--serve"]:
        raise SystemExit("sidecar_io.py 只支持受控 --serve 模式")
    serve()
