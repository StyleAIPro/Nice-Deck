import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "bundle_adapter", ROOT / "scripts/editor/bundle_adapter.py"
)
bundle_adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle_adapter)


def minimal_bundle(path, template=None):
    if template is None:
        template = '<!doctype html><body><div class="stage"></div></body>'
    path.write_text(
        '<script type="__bundler/manifest">\n{}\n</script>\n'
        '<script type="__bundler/template">\n'
        + json.dumps(template)
        + "\n</script>",
        encoding="utf-8",
    )


class BundleAdapterTest(unittest.TestCase):
    def test_write_is_idempotent_and_backup_is_exact(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = hashlib.sha256(deck.read_bytes()).hexdigest()

            result = bundle_adapter.write_patches(
                deck, [{"kind": "setText"}], Path(td) / "session"
            )
            first = deck.read_text(encoding="utf-8")
            bundle_adapter.write_patches(
                deck, [{"kind": "setText"}], Path(td) / "session"
            )

            self.assertEqual(first, deck.read_text(encoding="utf-8"))
            self.assertEqual(
                f"deck-{original}.html",
                Path(result["backup"]).name,
            )
            self.assertEqual(
                original,
                hashlib.sha256(Path(result["backup"]).read_bytes()).hexdigest(),
            )

    def test_verification_failure_keeps_original(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = deck.read_bytes()

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=AssertionError("bad"),
            ):
                with self.assertRaises(AssertionError):
                    bundle_adapter.write_patches(deck, [], Path(td) / "session")

            self.assertEqual(original, deck.read_bytes())
            self.assertEqual([], list(deck.parent.glob(f".{deck.name}.*.tmp")))

    def test_invalid_body_insert_points_are_rejected(self):
        cases = {
            "缺失 body 结束标签": "<!doctype html><body></bodyx>",
            "多个 body 结束标签": "<body></body><body></body>",
        }
        for name, template in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as td:
                deck = Path(td) / "deck.html"
                minimal_bundle(deck, template)
                original = deck.read_bytes()

                with self.assertRaisesRegex(ValueError, "必须恰好包含一个"):
                    bundle_adapter.write_patches(deck, [], Path(td) / "session")

                self.assertEqual(original, deck.read_bytes())

    def test_invalid_marker_shapes_are_rejected(self):
        begin = bundle_adapter.BEGIN
        end = bundle_adapter.END
        cases = {
            "仅 begin": f"<body>{begin}</body>",
            "仅 end": f"<body>{end}</body>",
            "重复 begin": f"<body>{begin}{begin}{end}</body>",
            "重复 end": f"<body>{begin}{end}{end}</body>",
            "逆序": f"<body>{end}{begin}</body>",
        }
        for name, template in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as td:
                deck = Path(td) / "deck.html"
                minimal_bundle(deck, template)
                original = deck.read_bytes()

                with self.assertRaisesRegex(ValueError, "补丁标记"):
                    bundle_adapter.write_patches(deck, [], Path(td) / "session")

                self.assertEqual(original, deck.read_bytes())

    def test_corrupt_existing_backup_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            original = deck.read_bytes()
            digest = hashlib.sha256(original).hexdigest()
            backups = Path(td) / "session" / "backups"
            backups.mkdir(parents=True)
            backup = backups / f"deck-{digest}.html"
            backup.write_bytes(b"corrupt")

            with self.assertRaisesRegex(RuntimeError, "备份"):
                bundle_adapter.write_patches(deck, [], Path(td) / "session")

            self.assertEqual(original, deck.read_bytes())
            self.assertEqual(b"corrupt", backup.read_bytes())

    def test_external_change_before_replace_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            minimal_bundle(deck)
            external = b"external change"
            original_verify = bundle_adapter.eb.verify

            def verify_then_change(path):
                original_verify(path)
                deck.write_bytes(external)

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=verify_then_change,
            ):
                with self.assertRaisesRegex(RuntimeError, "写入期间"):
                    bundle_adapter.write_patches(deck, [], Path(td) / "session")

            self.assertEqual(external, deck.read_bytes())
            self.assertEqual([], list(deck.parent.glob(f".{deck.name}.*.tmp")))

    def test_safe_verify_failure_has_stable_stage_and_diagnostic(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            session = Path(td) / "session"
            minimal_bundle(deck)
            original = deck.read_bytes()

            with mock.patch.object(
                bundle_adapter.eb,
                "verify",
                side_effect=AssertionError("verify exploded"),
            ):
                result = bundle_adapter.write_patches_safe(deck, [], session)

            self.assertEqual(False, result["ok"])
            self.assertEqual("VERIFY_FAILED", result["code"])
            self.assertEqual("verify", result["stage"])
            self.assertIn("重试", result["recovery"])
            self.assertTrue((session / result["diagnostic"]).is_file())
            self.assertEqual(original, deck.read_bytes())

    def test_expected_fingerprint_mismatch_is_conflict_without_write(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            session = Path(td) / "session"
            minimal_bundle(deck)
            original = deck.read_bytes()

            result = bundle_adapter.write_patches_safe(
                deck, [], session, expected_fingerprint="0" * 64
            )

            self.assertEqual("DECK_CHANGED", result["code"])
            self.assertEqual("read", result["stage"])
            self.assertEqual(original, deck.read_bytes())
            self.assertEqual([], list((session / "backups").glob("*.html")))

    def test_atomic_replace_failure_keeps_original_and_reports_write_stage(self):
        with tempfile.TemporaryDirectory() as td:
            deck = Path(td) / "deck.html"
            session = Path(td) / "session"
            minimal_bundle(deck)
            original = deck.read_bytes()

            with mock.patch.object(
                bundle_adapter.os,
                "replace",
                side_effect=OSError("replace denied"),
            ):
                result = bundle_adapter.write_patches_safe(deck, [], session)

            self.assertEqual("WRITE_FAILED", result["code"])
            self.assertEqual("replace", result["stage"])
            self.assertEqual(original, deck.read_bytes())
            self.assertEqual([], list(deck.parent.glob(f".{deck.name}.*.tmp")))
