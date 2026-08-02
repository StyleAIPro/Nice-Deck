from pathlib import Path
import hashlib
import importlib.util
import json
import os
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


def _ensure_backup(backup, original_bytes, digest):
    try:
        with backup.open("xb") as stream:
            stream.write(original_bytes)
    except FileExistsError:
        pass

    backup_bytes = backup.read_bytes()
    backup_digest = hashlib.sha256(backup_bytes).hexdigest()
    if backup_digest != digest or backup_bytes != original_bytes:
        raise RuntimeError(f"已有备份内容不一致或已损坏，拒绝继续：{backup}")


def write_patches(deck_path, patches, session_dir, expected_fingerprint=None):
    deck_path = Path(deck_path).resolve()
    session_dir = Path(session_dir).resolve()
    backups = session_dir / "backups"
    backups.mkdir(parents=True, exist_ok=True)
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
        backup = backups / f"{deck_path.stem}-{digest}.html"
        _ensure_backup(backup, original_bytes, digest)

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
    session_dir = Path(session_dir).resolve()
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
        diagnostics = session_dir / "write-errors"
        diagnostics.mkdir(parents=True, exist_ok=True)
        diagnostic = diagnostics / (
            "write-" + hashlib.sha256(os.urandom(32)).hexdigest()[:16] + ".json"
        )
        diagnostic.write_text(
            json.dumps(
                {
                    "code": code,
                    "stage": stage,
                    "message": str(error),
                    "errorType": type(error).__name__,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        return {
            "ok": False,
            "code": code,
            "stage": stage,
            "message": str(error) or "写回 Deck 失败",
            "recovery": recovery,
            "diagnostic": str(diagnostic.relative_to(session_dir)),
        }
