import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "huawei_deck_check_deps", ROOT / "scripts" / "check_deps.py"
)
doctor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(doctor)


class CheckDepsTest(unittest.TestCase):
    def test_profiles_keep_editor_core_independent_from_material_tools(self):
        editor_profiles, editor_checks = doctor.checks_for_profiles(["editor-core"])
        material_profiles, material_checks = doctor.checks_for_profiles(["materials"])

        self.assertEqual(editor_profiles, ("editor-core",))
        self.assertIn("node-pty", {check["key"] for check in editor_checks})
        self.assertNotIn("soffice", {check["key"] for check in editor_checks})
        self.assertEqual(material_profiles, ("materials",))
        self.assertIn("soffice", {check["key"] for check in material_checks})
        self.assertNotIn("node-pty", {check["key"] for check in material_checks})

    def test_snapshot_marks_missing_manual_dependency_without_failing_other_profile(self):
        probes = {
            "node": (True, "v20"),
            "ws": (True, "ok"),
            "html2canvas": (True, "ok"),
            "busboy": (True, "ok"),
            "node-pty": (True, "ok"),
            "@xterm/xterm": (True, "ok"),
            "three": (True, "ok"),
            "agent-cli": (True, "ok"),
            "soffice": (False, "未找到 soffice"),
        }

        def fake_probe(check):
            return probes.get(check["key"], (True, "ok"))

        with mock.patch.object(doctor, "do_probe", side_effect=fake_probe):
            editor = doctor.dependency_snapshot(["editor-core"])
            materials = doctor.dependency_snapshot(["materials"])

        self.assertTrue(editor["ready"])
        self.assertFalse(materials["ready"])
        self.assertEqual(
            materials["profiles"]["materials"]["state"],
            "manual-action-required",
        )

    def test_windows_standard_install_locations_find_chrome_and_soffice(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chrome = root / "Google" / "Chrome" / "Application" / "chrome.exe"
            soffice = root / "LibreOffice" / "program" / "soffice.exe"
            chrome.parent.mkdir(parents=True)
            soffice.parent.mkdir(parents=True)
            chrome.touch()
            soffice.touch()
            environment = {"PROGRAMFILES": directory, "PROGRAMFILES(X86)": "", "LOCALAPPDATA": ""}
            with mock.patch.object(doctor.sys, "platform", "win32"), \
                    mock.patch.dict(os.environ, environment, clear=False), \
                    mock.patch.object(doctor.shutil, "which", return_value=None):
                self.assertEqual(doctor.probe_chrome(), (True, str(chrome)))
                self.assertEqual(doctor.probe_soffice(), (True, str(soffice)))

    def test_windows_any_supported_agent_satisfies_editor_dependency(self):
        def which(name):
            return r"C:\Users\tester\AppData\Roaming\npm\claude.cmd" if name == "claude.cmd" else None

        with mock.patch.object(doctor.sys, "platform", "win32"), \
                mock.patch.object(doctor.shutil, "which", side_effect=which):
            ready, detail = doctor.probe_agent_cli()
        self.assertTrue(ready)
        self.assertIn("Claude Code", detail)

    def test_windows_agent_is_found_in_user_npm_bin_when_path_is_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            appdata = Path(directory)
            npm = appdata / "npm"
            npm.mkdir()
            claude = npm / "claude.cmd"
            claude.touch()
            with mock.patch.object(doctor.sys, "platform", "win32"), \
                    mock.patch.dict(os.environ, {
                        "APPDATA": str(appdata), "LOCALAPPDATA": "",
                        "USERPROFILE": "", "SystemDrive": str(appdata),
                    }, clear=False), \
                    mock.patch.object(doctor.shutil, "which", return_value=None):
                ready, detail = doctor.probe_agent_cli()
        self.assertTrue(ready)
        self.assertIn(str(claude), detail)

    def test_unencodable_status_symbol_has_ascii_fallback(self):
        fake_stdout = type("FakeStdout", (), {"encoding": "ascii"})()
        with mock.patch.object(doctor.sys, "stdout", fake_stdout):
            self.assertEqual(doctor._symbol("✓", "+"), "+")

    def test_python_module_probe_explains_incompatible_architecture(self):
        failure = doctor.subprocess.CompletedProcess(
            [doctor.sys.executable, "-c", "import pptx"],
            1,
            "",
            "ImportError: incompatible architecture (have 'arm64', need 'x86_64')",
        )
        with mock.patch.object(doctor, "run", return_value=failure):
            ready, detail = doctor.probe_pymod("pptx")()
        self.assertFalse(ready)
        self.assertEqual(detail, "已安装但架构不兼容（扩展 arm64，Editor Python x86_64）")

    def test_soffice_stale_shim_is_reported_as_broken_installation(self):
        failure = doctor.subprocess.CompletedProcess(
            ["/opt/homebrew/bin/soffice", "--version"],
            127,
            "",
            "/Applications/LibreOffice.app/Contents/MacOS/soffice: No such file or directory",
        )
        with mock.patch.object(doctor.shutil, "which", return_value="/opt/homebrew/bin/soffice"), \
                mock.patch.object(doctor, "run", return_value=failure):
            ready, detail = doctor.probe_soffice()
        self.assertFalse(ready)
        self.assertIn("找到 /opt/homebrew/bin/soffice，但无法启动", detail)


if __name__ == "__main__":
    unittest.main()
