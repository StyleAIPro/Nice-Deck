import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("check_deps", ROOT / "scripts/check_deps.py")
check_deps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_deps)


class NodeModuleProbeTest(unittest.TestCase):
    def test_builtin_module_exists(self):
        self.assertTrue(check_deps.probe_node_module("node:path")[0])

    def test_missing_module_is_false(self):
        self.assertFalse(check_deps.probe_node_module("huawei-deck-module-that-does-not-exist")[0])
