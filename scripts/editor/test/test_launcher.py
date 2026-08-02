import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("check_deps", ROOT / "scripts/check_deps.py")
check_deps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_deps)

LAUNCHER_SPEC = importlib.util.spec_from_file_location(
    "launcher", ROOT / "scripts/deck-editor.py"
)
launcher = importlib.util.module_from_spec(LAUNCHER_SPEC)
LAUNCHER_SPEC.loader.exec_module(launcher)


class NodeModuleProbeTest(unittest.TestCase):
    def test_builtin_module_exists(self):
        self.assertTrue(check_deps.probe_node_module("node:path")[0])

    def test_missing_module_is_false(self):
        self.assertFalse(check_deps.probe_node_module("huawei-deck-module-that-does-not-exist")[0])


class LauncherCommandTest(unittest.TestCase):
    def test_builds_node_command_without_shell(self):
        deck = ROOT / "Deck-Projects/renzhi/renzhi-deck.html"
        cmd = launcher.build_command(deck, host="127.0.0.1", port=0, no_open=True)
        self.assertEqual(cmd[:2], ["node", str(ROOT / "scripts/editor/server.mjs")])
        self.assertIn(str(deck.resolve()), cmd)
        self.assertNotIn("shell=True", repr(cmd))
