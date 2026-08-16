import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


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

    def test_matching_unmanaged_link_requires_explicit_adoption(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            target = home / ".agents" / "skills" / "huawei-deck"
            target.parent.mkdir(parents=True)
            target.symlink_to(root, target_is_directory=True)
            manager = self.make_manager(root, home)

            snapshot = manager.inspect()
            self.assertFalse(snapshot["ready"])
            self.assertEqual(snapshot["state"], "manual-action-required")
            self.assertEqual(snapshot["registrations"][0]["state"], "adoption-required")
            self.assertFalse(snapshot["registrations"][0]["managed"])
            with self.assertRaises(installer.InstallError) as raised:
                manager.plan("install")
            self.assertEqual(raised.exception.code, "INSTALL_ADOPTION_REQUIRED")
            self.assertFalse((home / "state" / "install-state.json").exists())

            result = manager.apply(manager.plan("install", adopt_existing=True))

            self.assertTrue(result["snapshot"]["ready"])
            self.assertTrue(result["snapshot"]["registrations"][0]["managed"])
            record = json.loads((home / "state" / "install-state.json").read_text("utf-8"))
            self.assertEqual(record["ownedPaths"], [str(manager.target_for("codex"))])

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

    def test_uninstall_does_not_remove_registration_missing_from_owned_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home)
            target = manager.target_for("codex")
            target.parent.mkdir(parents=True)
            target.symlink_to(root, target_is_directory=True)
            manager.state_file.parent.mkdir(parents=True)
            manager.state_file.write_text(json.dumps({
                "schemaVersion":installer.SCHEMA_VERSION,
                "installRoot":str(root.resolve()),
                "registrations":[{
                    "host":"codex", "targetPath":str(target), "method":"symlink",
                }],
                "ownedPaths":[],
            }), encoding="utf-8")

            manager.apply(manager.plan("uninstall"))

            self.assertTrue(target.is_symlink())
            self.assertEqual(target.resolve(), root.resolve())
            self.assertFalse(manager.state_file.exists())

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

    def test_uninstall_failure_restores_removed_registrations_and_state(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "repo"
            home = base / "home"
            root.mkdir()
            (root / "SKILL.md").write_text("skill", encoding="utf-8")
            manager = self.make_manager(root, home, hosts=("codex", "claude-code"))
            manager.apply(manager.plan("install"))
            state_before = (home / "state" / "install-state.json").read_bytes()
            targets = [manager.target_for(host) for host in ("codex", "claude-code")]
            original_remove = installer._remove_registration
            removals = 0

            def fail_second_removal(target, method):
                nonlocal removals
                removals += 1
                if removals == 2:
                    raise OSError("模拟第二个注册项删除失败")
                original_remove(target, method)

            with patch.object(installer, "_remove_registration", side_effect=fail_second_removal):
                with self.assertRaises(OSError):
                    manager.apply(manager.plan("uninstall"))

            self.assertEqual((home / "state" / "install-state.json").read_bytes(), state_before)
            for target in targets:
                self.assertTrue(target.is_symlink())
                self.assertEqual(target.resolve(), root.resolve())


if __name__ == "__main__":
    unittest.main()
