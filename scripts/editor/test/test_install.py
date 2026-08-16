import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "huawei_deck_install", ROOT / "scripts" / "install.py"
)
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallationManagerTest(unittest.TestCase):
    def make_manager(self, root, home, *, hosts=("codex",)):
        return installer.InstallationManager(
            root=root,
            home=home,
            hosts=hosts,
            state_file=home / "state" / "install-state.json",
            platform="darwin",
        )

    def test_install_is_idempotent_and_records_owned_link(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("---\nname: huawei-deck\n---\n", encoding="utf-8")
            manager = self.make_manager(root, home)

            first = manager.apply(manager.plan("install"))
            second = manager.apply(manager.plan("repair"))

            target = home / ".agents" / "skills" / "huawei-deck"
            self.assertTrue(target.is_symlink())
            self.assertEqual(target.resolve(), root.resolve())
            self.assertTrue(first["snapshot"]["ready"])
            self.assertTrue(second["snapshot"]["ready"])
            record = json.loads((home / "state" / "install-state.json").read_text("utf-8"))
            self.assertEqual(record["ownedPaths"], [str(manager.target_for("codex"))])

    def test_unknown_existing_target_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            target = home / ".agents" / "skills" / "huawei-deck"
            target.mkdir(parents=True)
            (target / "user-file.txt").write_text("keep", encoding="utf-8")
            manager = self.make_manager(root, home)

            with self.assertRaises(installer.InstallError) as raised:
                manager.plan("install")

            self.assertEqual(raised.exception.code, "INSTALL_TARGET_OCCUPIED")
            self.assertEqual((target / "user-file.txt").read_text("utf-8"), "keep")

    def test_uninstall_only_removes_recorded_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home)
            manager.apply(manager.plan("install"))

            result = manager.apply(manager.plan("uninstall"))

            target = home / ".agents" / "skills" / "huawei-deck"
            self.assertFalse(target.exists())
            self.assertFalse((home / "state" / "install-state.json").exists())
            self.assertEqual(result["status"], "uninstalled")
            self.assertTrue(root.exists())

    def test_uninstall_refuses_changed_target(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            other = base / "other"
            home = base / "home"
            root.mkdir()
            other.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home)
            manager.apply(manager.plan("install"))
            target = home / ".agents" / "skills" / "huawei-deck"
            target.unlink()
            target.symlink_to(other, target_is_directory=True)

            with self.assertRaises(installer.InstallError) as raised:
                manager.plan("uninstall")

            self.assertEqual(raised.exception.code, "UNINSTALL_TARGET_CHANGED")
            self.assertEqual(target.resolve(), other.resolve())


if __name__ == "__main__":
    unittest.main()
