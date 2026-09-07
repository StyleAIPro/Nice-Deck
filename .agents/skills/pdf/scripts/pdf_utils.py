"""材料脚本共用的 PDF 打开与原子保存；只依赖 PyMuPDF。"""
import os
from contextlib import contextmanager
from pathlib import Path
import tempfile

import pymupdf


def open_pdf(path):
    doc = pymupdf.open(path)
    if not doc.is_pdf or doc.needs_pass:
        doc.close()
        raise ValueError("需要未加密或已解密的 PDF 文件")
    return doc


@contextmanager
def atomic_pdf_output(source, output):
    """在临时文件上写入、复检后发布结果；相同文件或硬链接均拒绝。"""
    source, output = Path(source).resolve(), Path(output).absolute()
    if output.resolve() == source or (output.exists() and os.path.samefile(source, output)):
        raise ValueError("输出必须使用其他文件名，不能覆盖原 PDF")
    fd, temporary = tempfile.mkstemp(prefix=".pdf-", suffix=".pdf", dir=output.parent)
    os.close(fd)
    try:
        yield temporary
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def require_unsigned(doc):
    for page in doc:
        if any(widget.is_signed for widget in page.widgets() or []):
            raise ValueError("不改写已签名 PDF；请使用未签名副本")


def save_pdf(doc, source, output):
    require_unsigned(doc)
    with atomic_pdf_output(source, output) as temporary:
        doc.save(temporary, garbage=3, deflate=True)
