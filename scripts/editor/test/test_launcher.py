import importlib.util
import json
import os
import plistlib
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check_deps = load_module("check_deps", ROOT / "scripts/check_deps.py")
launcher = load_module("launcher", ROOT / "scripts/deck-editor.py")
DECK = ROOT / "assets/template-deck.html"


class LauncherTest(unittest.TestCase):
    def test_required_node_module_probe(self):
        self.assertTrue(check_deps.probe_node_module("node:path")[0])
        self.assertFalse(check_deps.probe_node_module("module-that-does-not-exist")[0])

    def test_direct_path_and_empty_app_use_different_node_entries(self):
        thread_id = "019fc842-816b-7413-bb23-10b0f87e1d4c"
        direct = launcher.build_command(
            DECK, no_open=True, agent_thread_id=thread_id
        )
        empty_app = launcher.build_app_command(no_open=True)
        self.assertEqual(direct[1], str(ROOT / "scripts/editor/server.mjs"))
        self.assertIn(str(DECK.resolve()), direct)
        self.assertEqual(direct[direct.index("--agent-thread-id") + 1], thread_id)
        self.assertEqual(empty_app[1], str(ROOT / "scripts/editor/app-server.mjs"))
        self.assertIn("--python", empty_app)

    def test_main_routes_without_opening_picker_eagerly(self):
        with (
            mock.patch.object(launcher, "choose_deck") as choose_deck,
            mock.patch.object(launcher, "prepare_editor_runtime") as prepare,
            mock.patch.object(launcher, "run_editor", return_value=0) as run_editor,
        ):
            self.assertEqual(launcher.main(["--app"]), 0)
        choose_deck.assert_not_called()
        prepare.assert_called_once_with(auto_install=True)
        self.assertIn("app-server.mjs", run_editor.call_args.args[0][1])

        with mock.patch.object(launcher, "run_editor", return_value=0) as run_editor:
            self.assertEqual(launcher.main([str(DECK), "--no-open"]), 0)
        self.assertIn("server.mjs", run_editor.call_args.args[0][1])
        self.assertNotIn("--exit-when-editor-closes", run_editor.call_args.args[0])

    def test_pick_only_has_small_machine_readable_contract(self):
        with mock.patch.object(launcher, "choose_deck", return_value=DECK):
            with mock.patch("sys.stdout") as stdout:
                self.assertEqual(launcher.main(["--pick-only"]), 0)
        payload = json.loads("".join(call.args[0] for call in stdout.write.call_args_list))
        self.assertEqual(payload["deckPath"], str(DECK.resolve()))

        with mock.patch.object(launcher, "choose_deck", return_value=None):
            self.assertEqual(launcher.main(["--pick-only"]), 3)

    def test_finder_argument_and_ctrl_c_are_quiet(self):
        self.assertEqual(launcher.normalize_argv(["-psn_0_123", "deck.html"]), ["deck.html"])
        with mock.patch.object(launcher.subprocess, "call", side_effect=KeyboardInterrupt):
            self.assertEqual(launcher.run_editor(["node", "server.mjs"]), 130)

    def test_dependency_failure_explains_node_requirement(self):
        with mock.patch.object(
            launcher, "editor_dependency_status",
            return_value=(False, "Node.js 未就绪：未安装 node"),
        ):
            with self.assertRaisesRegex(launcher.LauncherError, "Node.js 18"):
                launcher.prepare_editor_runtime(auto_install=True)

    def test_macos_app_bundle_points_to_unified_launcher(self):
        app = ROOT / "Huawei Deck 编辑器.app"
        executable = app / "Contents/MacOS/HuaweiDeckEditor"
        with (app / "Contents/Info.plist").open("rb") as source:
            info = plistlib.load(source)
        self.assertEqual(info["CFBundleExecutable"], executable.name)
        self.assertEqual(info["CFBundlePackageType"], "APPL")
        self.assertEqual(info["CFBundleVersion"], "2")
        self.assertTrue(os.access(executable, os.X_OK))
        contents = executable.read_text(encoding="utf-8")
        self.assertIn("scripts/deck-editor.py", contents)
        self.assertIn("/usr/bin/nohup", contents)
        self.assertNotIn("exec python3", contents)
