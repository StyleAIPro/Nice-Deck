import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "sidecar_io.py"
SPEC = importlib.util.spec_from_file_location("sidecar_io", MODULE_PATH)
sidecar_io = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sidecar_io)


class SidecarAtomicWriteTest(unittest.TestCase):
    def test_directory_fsync_failure_reports_snapshot_commit_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            real_fsync = sidecar_io.os.fsync

            def fail_directory_fsync(fd):
                if fd == directory_fd:
                    raise OSError("injected snapshot directory fsync failure")
                return real_fsync(fd)

            try:
                with mock.patch.object(
                    sidecar_io.os, "fsync", side_effect=fail_directory_fsync
                ):
                    with self.assertRaises(sidecar_io.SidecarIOError) as caught:
                        sidecar_io._atomic_write_fd(
                            directory_fd, "snapshot.png", b"png", commit_scope="snapshot"
                        )
            finally:
                os.close(directory_fd)

            error = caught.exception
            self.assertTrue(error.committed)
            self.assertEqual(error.commit_scope, "snapshot")
            self.assertEqual(error.stage, "snapshot-directory-fsync")
            self.assertEqual(error.code, "SNAPSHOT_WRITE_FAILED")
            self.assertEqual((Path(directory) / "snapshot.png").read_bytes(), b"png")


if __name__ == "__main__":
    unittest.main()
