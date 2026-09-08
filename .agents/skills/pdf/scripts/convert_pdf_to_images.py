"""逐页输出 page_1.png 等预览；不再需要 Poppler 或 Pillow。"""
from pathlib import Path
import sys
import pymupdf
from pdf_utils import open_pdf


def convert(pdf_path, output_dir, max_dim=1000):
    if max_dim <= 0:
        raise ValueError("最大边长必须大于零")
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    with open_pdf(pdf_path) as doc:
        for number, page in enumerate(doc, 1):
            scale = min(200 / 72, max_dim / max(page.rect.width, page.rect.height))
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            path = directory / f"page_{number}.png"
            pix.save(path)
            print(f"已保存第 {number} 页：{path}（{pix.width}×{pix.height}）")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit("用法：convert_pdf_to_images.py <input.pdf> <output_directory> [最大边长]")
    convert(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) == 4 else 1000)
