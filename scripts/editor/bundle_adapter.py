from pathlib import Path
import hashlib
import importlib.util
import json
import os
import shutil
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


def write_patches(deck_path, patches, session_dir):
    deck_path = Path(deck_path).resolve()
    session_dir = Path(session_dir).resolve()
    backups = session_dir / "backups"
    backups.mkdir(parents=True, exist_ok=True)

    digest = hashlib.sha256(deck_path.read_bytes()).hexdigest()
    backup = backups / f"{deck_path.stem}-{digest[:8]}.html"
    if not backup.exists():
        shutil.copy2(deck_path, backup)

    lines = eb.load(deck_path)
    template = eb.get_template(lines)
    block = _block(patches)
    if BEGIN in template:
        start = template.index(BEGIN)
        end = template.index(END) + len(END)
        template = template[:start] + block + template[end:]
    else:
        template = template.replace("</body>", block + "\n</body>")
    eb.set_template(lines, template)

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{deck_path.name}.", suffix=".tmp", dir=deck_path.parent
    )
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        eb.save(tmp, lines)
        eb.verify(tmp)
        os.replace(tmp, deck_path)
    finally:
        if tmp.exists():
            tmp.unlink()

    return {
        "backup": str(backup),
        "fingerprint": hashlib.sha256(deck_path.read_bytes()).hexdigest(),
    }
