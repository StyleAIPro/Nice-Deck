from pathlib import Path
import hashlib
import importlib.util
import json
import os
import stat
import tempfile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("eb", ROOT / "scripts/edit-bundle.py")
eb = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(eb)

BEGIN = "<!-- huawei-deck-editor:begin -->"
END = "<!-- huawei-deck-editor:end -->"


def _block(patches):
    runtime = (ROOT / "scripts/editor/runtime/patch-runtime.js").read_text(
        encoding="utf-8"
    )
    data = json.dumps(
        patches, ensure_ascii=False, separators=(",", ":")
    ).replace("</", "<\\u002F")
    return (
        f'{BEGIN}\n<script type="application/json" '
        f'id="huawei-deck-editor-patches">{data}</script>\n'
        f"<script>{runtime}\n"
        ";window.HuaweiDeckPatchRuntime.applyAll?.(JSON.parse(document."
        'getElementById("huawei-deck-editor-patches").textContent));</script>\n'
        f"{END}"
    )


def _absolute_path(path):
    return Path(os.path.abspath(os.fspath(path)))


def _ensure_plain_directory(path, parent=None):
    path = _absolute_path(path)
    try:
        path.mkdir(mode=0o700, parents=parent is None, exist_ok=False)
    except FileExistsError:
        pass
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"目录必须是非符号链接的真实目录：{path}")
    real_path = Path(os.path.realpath(path))
    if parent is not None:
        real_parent = Path(os.path.realpath(parent))
        if real_path.parent != real_parent:
            raise RuntimeError(f"目录不在当前会话边界内：{path}")
    return path


def _open_directory_fd(path):
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):
        os.close(fd)
        raise RuntimeError(f"目录句柄不是常规目录：{path}")
    return fd


def _write_new_file(directory, name, contents):
    directory_fd = _open_directory_fd(directory)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(contents)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
    finally:
        os.close(directory_fd)


def _read_regular_file(directory, name):
    directory_fd = _open_directory_fd(directory)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(name, flags, dir_fd=directory_fd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise RuntimeError(f"备份必须是非符号链接的常规文件：{directory / name}")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                return stream.read()
        finally:
            os.close(fd)
    finally:
        os.close(directory_fd)


def _ensure_backup(backups, name, original_bytes, digest):
    try:
        _write_new_file(backups, name, original_bytes)
    except FileExistsError:
        pass

    try:
        backup_bytes = _read_regular_file(backups, name)
    except OSError as error:
        raise RuntimeError(
            f"备份必须是非符号链接的常规文件：{backups / name}"
        ) from error
    backup_digest = hashlib.sha256(backup_bytes).hexdigest()
    if backup_digest != digest or backup_bytes != original_bytes:
        raise RuntimeError(f"已有备份内容不一致或已损坏，拒绝继续：{backups / name}")


def write_patches(deck_path, patches, session_dir, expected_fingerprint=None):
    deck_path = _absolute_path(deck_path)
    session_dir = _ensure_plain_directory(session_dir)
    backups = _ensure_plain_directory(session_dir / "backups", parent=session_dir)
    phase = "read"
    tmp = None
    try:
        original_bytes = deck_path.read_bytes()
        digest = hashlib.sha256(original_bytes).hexdigest()
        if expected_fingerprint is not None and digest != expected_fingerprint:
            error = RuntimeError("Deck 指纹与保存请求基线不一致，拒绝覆盖")
            error.deck_code = "DECK_CHANGED"
            raise error

        phase = "backup"
        backup_name = f"{deck_path.stem}-{digest}.html"
        backup = backups / backup_name
        _ensure_backup(backups, backup_name, original_bytes, digest)

        phase = "decode"
        lines = eb.load(deck_path)
        template = eb.get_template(lines)
        block = _block(patches)
        begin_count = template.count(BEGIN)
        end_count = template.count(END)
        if begin_count or end_count:
            if (
                begin_count != 1
                or end_count != 1
                or template.index(BEGIN) >= template.index(END)
            ):
                raise ValueError("Deck 补丁标记必须各恰好出现一次且顺序正确")
            start = template.index(BEGIN)
            end = template.index(END) + len(END)
            template = template[:start] + block + template[end:]
        else:
            if template.count("</body>") != 1:
                raise ValueError("Deck 模板必须恰好包含一个精确 </body> 插入点")
            template = template.replace("</body>", block + "\n</body>", 1)

        if template.count(BEGIN) != 1 or template.count(END) != 1:
            raise ValueError("构造后的 Deck 补丁标记必须各恰好出现一次")
        eb.set_template(lines, template)

        phase = "temp-write"
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{deck_path.name}.", suffix=".tmp", dir=deck_path.parent
        )
        os.close(fd)
        tmp = Path(tmp_name)
        eb.save(tmp, lines)

        phase = "verify"
        eb.verify(tmp)
        written_fingerprint = hashlib.sha256(tmp.read_bytes()).hexdigest()

        phase = "fingerprint"
        if deck_path.read_bytes() != original_bytes:
            error = RuntimeError("Deck 在写入期间已发生变化，拒绝覆盖")
            error.deck_code = "DECK_CHANGED"
            raise error

        phase = "replace"
        os.replace(tmp, deck_path)
    except Exception as error:
        if not hasattr(error, "deck_stage"):
            error.deck_stage = phase
        if tmp is not None and tmp.exists():
            try:
                error.deck_candidate_bytes = tmp.read_bytes()
            except OSError:
                pass
        raise
    finally:
        if tmp is not None and tmp.exists():
            tmp.unlink()

    return {
        "ok": True,
        "backup": str(backup),
        "fingerprint": written_fingerprint,
    }


def write_patches_safe(deck_path, patches, session_dir, expected_fingerprint=None):
    """供 Node 服务调用的稳定结果封装；底层 write_patches 仍保留原异常类型便于测试。"""
    session_dir = _absolute_path(session_dir)
    try:
        return write_patches(
            deck_path, patches, session_dir, expected_fingerprint=expected_fingerprint
        )
    except Exception as error:
        stage = getattr(error, "deck_stage", "write")
        code = getattr(error, "deck_code", None)
        if code is None:
            code = "VERIFY_FAILED" if stage in {"decode", "verify"} else "WRITE_FAILED"
        recovery = {
            "DECK_CHANGED": "重新载入外部文件并在新基线上重放补丁，或另存为副本",
            "VERIFY_FAILED": "检查 bundle 结构和补丁定位器后重试",
            "WRITE_FAILED": "检查备份、目录权限和磁盘空间后重试",
        }[code]
        result = {
            "ok": False,
            "code": code,
            "stage": stage,
            "message": str(error) or "写回 Deck 失败",
            "recovery": recovery,
        }
        try:
            safe_session = _ensure_plain_directory(session_dir)
            diagnostics = _ensure_plain_directory(
                safe_session / "write-errors", parent=safe_session
            )
            token = hashlib.sha256(os.urandom(32)).hexdigest()[:16]
            candidate_bytes = getattr(error, "deck_candidate_bytes", None)
            candidate_relative = None
            if isinstance(candidate_bytes, bytes):
                candidate_name = f"candidate-{token}.html"
                _write_new_file(diagnostics, candidate_name, candidate_bytes)
                candidate_relative = f"write-errors/{candidate_name}"
                result["candidate"] = candidate_relative
            diagnostic_name = f"write-{token}.json"
            diagnostic_relative = f"write-errors/{diagnostic_name}"
            diagnostic_payload = {
                "code": code,
                "stage": stage,
                "message": str(error),
                "errorType": type(error).__name__,
            }
            if candidate_relative is not None:
                diagnostic_payload["candidate"] = candidate_relative
            _write_new_file(
                diagnostics,
                diagnostic_name,
                json.dumps(
                    diagnostic_payload, ensure_ascii=False, indent=2
                ).encode("utf-8"),
            )
            result["diagnostic"] = diagnostic_relative
        except Exception as diagnostic_error:
            result["diagnosticError"] = str(diagnostic_error)
        return result
