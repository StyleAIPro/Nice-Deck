import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "bundle_adapter", ROOT / "scripts/editor/bundle_adapter.py"
)
bundle_adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle_adapter)


def minimal_bundle(path):
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
                original,
                hashlib.sha256(Path(result["backup"]).read_bytes()).hexdigest(),
            )

    def test_verification_failure_keeps_original(self):
        from unittest import mock

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
