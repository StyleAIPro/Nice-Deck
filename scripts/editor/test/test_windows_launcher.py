import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WINDOWS_LAUNCHER = ROOT / "Huawei Deck 编辑器.cmd"


class WindowsLauncherTest(unittest.TestCase):
    def test_windows_launcher_points_to_unified_python_entry(self):
        contents = WINDOWS_LAUNCHER.read_text(encoding="utf-8")

        self.assertIn(r"%~dp0scripts\deck-editor.py", contents)
        self.assertIn("--app", contents)
        self.assertIn("--detach-windows", contents)
        self.assertIn("%*", contents)
        self.assertNotIn("/min", contents)
        self.assertNotIn('start "Huawei Deck 编辑器"', contents)
        for executable in ("py.exe", "python.exe"):
            self.assertIn(executable, contents)
        self.assertIn('pushd "%~dp0"', contents)

    def test_entry_documents_explain_the_windows_double_click_entry(self):
        for relative_path in (
            "SKILL.md",
            "README.md",
            "references/editing-guide.md",
            "docs/architecture.md",
        ):
            with self.subTest(file=relative_path):
                contents = (ROOT / relative_path).read_text(encoding="utf-8")
                self.assertIn("Huawei Deck 编辑器.cmd", contents)
                self.assertIn("Windows", contents)


if __name__ == "__main__":
    unittest.main()
