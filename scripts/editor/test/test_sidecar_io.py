import importlib.util
import hashlib
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "sidecar_io.py"
SPEC = importlib.util.spec_from_file_location("sidecar_io", MODULE_PATH)
sidecar_io = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sidecar_io)


SESSION_ID = "123e4567-e89b-42d3-a456-426614174000"
UPLOAD_ID = "223e4567-e89b-42d3-a456-426614174000"
SECOND_UPLOAD_ID = "323e4567-e89b-42d3-a456-426614174000"
TASK_ID = "423e4567-e89b-42d3-a456-426614174000"
ORPHAN_TASK_ID = "523e4567-e89b-42d3-a456-426614174000"
ATTACHMENT_ID = "623e4567-e89b-42d3-a456-426614174000"
SECOND_ATTACHMENT_ID = "723e4567-e89b-42d3-a456-426614174000"


def directory_identity(path):
    info = os.lstat(path)
    return {
        "path": str(path),
        "realPath": str(path.resolve()),
        "dev": str(info.st_dev),
        "ino": str(info.st_ino),
    }


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

    def test_linux_statx_mount_id_boundary_requires_reported_mount_id(self):
        def fake_statx(_fd, _path, _flags, _mask, buffer):
            raw = bytearray(256)
            struct.pack_into("=I", raw, 0, 0x00001000)
            struct.pack_into("=Q", raw, 144, 987654321)
            sidecar_io.ctypes.memmove(sidecar_io.ctypes.addressof(buffer), bytes(raw), len(raw))
            return 0

        self.assertEqual(
            sidecar_io._linux_mount_id(42, statx_call=fake_statx), 987654321
        )

        def missing_mount_id(_fd, _path, _flags, _mask, buffer):
            sidecar_io.ctypes.memset(sidecar_io.ctypes.addressof(buffer), 0, 256)
            return 0

        with self.assertRaises(sidecar_io.SidecarIOError):
            sidecar_io._linux_mount_id(42, statx_call=missing_mount_id)


class SidecarAttachmentIOTest(unittest.TestCase):
    def make_bound_helper(self, *, bind_attachments=True):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        project = Path(temporary.name)
        root = project / ".huawei-deck-editor"
        root.mkdir()
        deck = project / "deck.html"
        deck.write_bytes(b"deck")
        fingerprint = hashlib.sha256(deck.read_bytes()).hexdigest()
        session_name = f"deck-{fingerprint[:8]}"
        session = root / session_name
        for name in ("snapshots", "backups", "transactions", "write-errors"):
            (session / name).mkdir(parents=True, exist_ok=True)
        (session / "session.json").write_text(json.dumps({
            "version": 1,
            "sessionId": SESSION_ID,
            "deckPath": str(deck.resolve()),
            "deckFingerprint": fingerprint,
            "revision": 0,
            "tasks": [],
            "groups": [],
            "redo": [],
        }))
        (root / "sessions.json").write_text(json.dumps({
            "version": 1,
            "sessions": {
                SESSION_ID: {
                    "sessionId": SESSION_ID,
                    "deckRealPath": str(deck.resolve()),
                    "initialFingerprint": fingerprint,
                    "sessionName": session_name,
                    "mode": "legacy",
                    "status": "active",
                }
            },
        }))
        helper = sidecar_io.PersistentHelper()
        helper.initialize({
            "project": directory_identity(project),
            "root": directory_identity(root),
        })
        self.addCleanup(helper.close)
        core_binding = helper.bind_session({
            "deckName": "deck.html",
            "sessionId": SESSION_ID,
            "sessionName": session_name,
            "create": False,
        })
        if not bind_attachments:
            return helper, session, core_binding
        attachment_binding = helper.bind_attachments({})
        binding = {
            "sessionName": core_binding["sessionName"],
            "identities": {
                **core_binding["identities"], **attachment_binding["identities"]
            },
        }
        return helper, session, binding

    @staticmethod
    def stage_files(session, upload_id=UPLOAD_ID):
        upload = session / "attachments" / ".staging" / upload_id
        upload.mkdir()
        first = b"png-data"
        second = b"notes"
        (upload / f"{ATTACHMENT_ID}.png").write_bytes(first)
        (upload / f"{SECOND_ATTACHMENT_ID}.txt").write_bytes(second)
        return upload, [
            {"id": ATTACHMENT_ID, "suffix": ".png", "size": len(first)},
            {"id": SECOND_ATTACHMENT_ID, "suffix": ".txt", "size": len(second)},
        ]

    def test_legacy_bind_creates_and_binds_real_attachment_directories(self):
        helper, session, binding = self.make_bound_helper()

        self.assertTrue((session / "attachments").is_dir())
        self.assertTrue((session / "attachments" / ".staging").is_dir())
        self.assertFalse((session / "attachments").is_symlink())
        self.assertFalse((session / "attachments" / ".staging").is_symlink())
        self.assertIn("attachments", binding["identities"])
        self.assertIn("attachmentStaging", binding["identities"])
        self.assertEqual(helper.assert_bound({}), {"safe": True})

    def test_publish_atomically_moves_verified_staged_files_without_paths(self):
        helper, session, _ = self.make_bound_helper()
        upload, files = self.stage_files(session)

        published = helper.publish_attachments({
            "uploadId": UPLOAD_ID,
            "taskId": TASK_ID,
            "files": files,
        })

        self.assertEqual(published, [
            {
                "id": ATTACHMENT_ID,
                "relativePath": f"attachments/{TASK_ID}/{ATTACHMENT_ID}.png",
                "size": 8,
            },
            {
                "id": SECOND_ATTACHMENT_ID,
                "relativePath": f"attachments/{TASK_ID}/{SECOND_ATTACHMENT_ID}.txt",
                "size": 5,
            },
        ])
        self.assertFalse(upload.exists())
        self.assertEqual(
            (session / "attachments" / TASK_ID / f"{ATTACHMENT_ID}.png").read_bytes(),
            b"png-data",
        )

    def test_publish_refuses_existing_task_or_unverified_receipt_without_mutation(self):
        helper, session, _ = self.make_bound_helper()
        upload, files = self.stage_files(session)
        existing = session / "attachments" / TASK_ID
        existing.mkdir()

        with self.assertRaises(sidecar_io.SidecarIOError):
            helper.publish_attachments({
                "uploadId": UPLOAD_ID,
                "taskId": TASK_ID,
                "files": files,
            })
        self.assertTrue(upload.is_dir())
        self.assertTrue(existing.is_dir())

        existing.rmdir()
        with self.assertRaises(sidecar_io.SidecarIOError):
            helper.publish_attachments({
                "uploadId": UPLOAD_ID,
                "taskId": TASK_ID,
                "files": [{**files[0], "size": files[0]["size"] + 1}, files[1]],
            })
        with self.assertRaises(sidecar_io.SidecarIOError):
            helper.publish_attachments({
                "uploadId": UPLOAD_ID,
                "taskId": TASK_ID,
                "files": [{**files[0], "path": "/tmp/forged"}, files[1]],
            })
        self.assertTrue(upload.is_dir())

    def test_receipt_size_mismatch_is_rejected_before_hashing_file(self):
        _, session, _ = self.make_bound_helper()
        upload, files = self.stage_files(session)
        directory_fd = os.open(
            upload, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        )
        forged = [{**files[0], "size": files[0]["size"] + 1}, files[1]]
        try:
            with mock.patch.object(
                sidecar_io,
                "_hash_open_file",
                side_effect=AssertionError("不应读取 size 已不匹配的文件"),
            ):
                with self.assertRaises(sidecar_io.SidecarIOError):
                    sidecar_io._scan_attachment_files(
                        directory_fd, expected=forged, keep_open=True
                    )
        finally:
            os.close(directory_fd)

    def test_discard_upload_and_delete_task_only_remove_verified_uuid_directory(self):
        helper, session, _ = self.make_bound_helper()
        upload, _ = self.stage_files(session)
        self.assertEqual(
            helper.discard_attachment_upload({"uploadId": UPLOAD_ID}),
            {"removed": True},
        )
        self.assertFalse(upload.exists())

        task = session / "attachments" / TASK_ID
        task.mkdir()
        (task / f"{ATTACHMENT_ID}.bin").write_bytes(b"bytes")
        self.assertEqual(
            helper.delete_task_attachments({"taskId": TASK_ID}),
            {"removed": True},
        )
        self.assertFalse(task.exists())
        self.assertEqual(
            helper.delete_task_attachments({"taskId": TASK_ID}),
            {"removed": False},
        )

    def test_delete_rejects_symlink_file_and_never_follows_it(self):
        helper, session, _ = self.make_bound_helper()
        outside = session.parent / "outside.txt"
        outside.write_bytes(b"sentinel")
        task = session / "attachments" / TASK_ID
        task.mkdir()
        forged = task / f"{ATTACHMENT_ID}.txt"
        forged.symlink_to(outside)

        with self.assertRaises(sidecar_io.SidecarIOError):
            helper.delete_task_attachments({"taskId": TASK_ID})

        self.assertEqual(outside.read_bytes(), b"sentinel")
        self.assertTrue(forged.is_symlink())

    def test_reconcile_clears_staging_and_orphans_but_keeps_referenced_task(self):
        helper, session, _ = self.make_bound_helper()
        attachments = session / "attachments"
        referenced = attachments / TASK_ID
        referenced.mkdir()
        (referenced / f"{ATTACHMENT_ID}.png").write_bytes(b"keep")
        orphan = attachments / ORPHAN_TASK_ID
        orphan.mkdir()
        (orphan / f"{SECOND_ATTACHMENT_ID}.txt").write_bytes(b"remove")
        self.stage_files(session, UPLOAD_ID)
        second_upload, _ = self.stage_files(session, SECOND_UPLOAD_ID)

        result = helper.reconcile_attachments({"referencedTaskIds": [TASK_ID]})

        self.assertEqual(result, {"discardedUploads": 2, "deletedTasks": 1})
        self.assertTrue(referenced.is_dir())
        self.assertFalse(orphan.exists())
        self.assertFalse(second_upload.exists())
        self.assertEqual(list((attachments / ".staging").iterdir()), [])

    def test_reconcile_fails_closed_before_deleting_when_tree_has_unknown_entry(self):
        helper, session, _ = self.make_bound_helper()
        attachments = session / "attachments"
        orphan = attachments / ORPHAN_TASK_ID
        orphan.mkdir()
        (orphan / f"{ATTACHMENT_ID}.png").write_bytes(b"orphan")
        unknown = attachments / "not-a-uuid"
        unknown.mkdir()

        with self.assertRaises(sidecar_io.SidecarIOError):
            helper.reconcile_attachments({"referencedTaskIds": []})

        self.assertTrue(orphan.is_dir(), "发现未知条目后不得先删除合法孤儿")
        self.assertTrue(unknown.is_dir())

    def test_attachment_commands_reject_bound_directory_identity_drift(self):
        for level in ("attachments", "staging"):
            with self.subTest(level=level):
                helper, session, _ = self.make_bound_helper()
                attachments = session / "attachments"
                target = attachments if level == "attachments" else attachments / ".staging"
                trusted = target.with_name(f"{target.name}.trusted")
                target.rename(trusted)
                outside = session.parent / f"outside-{level}"
                outside.mkdir()
                target.symlink_to(outside, target_is_directory=True)

                operations = (
                    lambda: helper.publish_attachments({
                        "uploadId": UPLOAD_ID, "taskId": TASK_ID,
                        "files": [{
                            "id": ATTACHMENT_ID, "suffix": ".png", "size": 1,
                        }],
                    }),
                    lambda: helper.discard_attachment_upload({"uploadId": UPLOAD_ID}),
                    lambda: helper.delete_task_attachments({"taskId": TASK_ID}),
                    lambda: helper.reconcile_attachments({"referencedTaskIds": []}),
                )
                for operation in operations:
                    with self.assertRaises(sidecar_io.SidecarIOError) as caught:
                        operation()
                    self.assertEqual(caught.exception.code, "UNSAFE_SIDECAR_IO")
                self.assertEqual(list(outside.iterdir()), [])

    def test_publish_rejects_hardlinked_staged_file(self):
        helper, session, _ = self.make_bound_helper()
        upload, files = self.stage_files(session)
        outside_link = session.parent / "outside-hardlink.png"
        os.link(upload / f"{ATTACHMENT_ID}.png", outside_link)

        with self.assertRaises(sidecar_io.SidecarIOError):
            helper.publish_attachments({
                "uploadId": UPLOAD_ID, "taskId": TASK_ID, "files": files,
            })

        self.assertTrue(upload.is_dir())
        self.assertEqual(outside_link.read_bytes(), b"png-data")

    def test_publish_detects_equal_size_rewrite_during_atomic_rename(self):
        helper, session, _ = self.make_bound_helper()
        _, files = self.stage_files(session)
        real_rename = sidecar_io._rename_directory_no_replace

        def rename_then_rewrite(*args):
            real_rename(*args)
            target = session / "attachments" / TASK_ID / f"{ATTACHMENT_ID}.png"
            target.write_bytes(b"PNG-DATA")

        with mock.patch.object(
            sidecar_io, "_rename_directory_no_replace", side_effect=rename_then_rewrite
        ):
            with self.assertRaises(sidecar_io.SidecarIOError) as caught:
                helper.publish_attachments({
                    "uploadId": UPLOAD_ID, "taskId": TASK_ID, "files": files,
                })

        self.assertTrue(caught.exception.committed)
        self.assertEqual(caught.exception.commit_scope, "attachments")

    def test_publish_attempts_both_parent_fsyncs_and_aggregates_failures(self):
        helper, session, _ = self.make_bound_helper()
        self.stage_files(session)
        real_fsync = sidecar_io.os.fsync
        parent_calls = []

        def fail_both_parents(fd):
            if fd == helper.attachment_staging_fd:
                parent_calls.append("staging")
                raise OSError("injected staging parent fsync failure")
            if fd == helper.attachments_fd:
                parent_calls.append("attachments")
                raise OSError("injected attachments parent fsync failure")
            return real_fsync(fd)

        with mock.patch.object(sidecar_io.os, "fsync", side_effect=fail_both_parents):
            with self.assertRaises(sidecar_io.SidecarIOError) as caught:
                helper.publish_attachments({
                    "uploadId": UPLOAD_ID,
                    "taskId": TASK_ID,
                    "files": [
                        {"id": ATTACHMENT_ID, "suffix": ".png", "size": 8},
                        {"id": SECOND_ATTACHMENT_ID, "suffix": ".txt", "size": 5},
                    ],
                })

        self.assertEqual(parent_calls, ["staging", "attachments"])
        self.assertTrue(caught.exception.committed)
        self.assertEqual(caught.exception.commit_scope, "attachments")
        self.assertIn("staging", str(caught.exception))
        self.assertIn("attachments", str(caught.exception))
        self.assertTrue((session / "attachments" / TASK_ID).is_dir())

    def test_reconcile_race_after_preflight_fails_before_any_partial_delete(self):
        helper, session, _ = self.make_bound_helper()
        upload, _ = self.stage_files(session)
        orphan = session / "attachments" / ORPHAN_TASK_ID
        orphan.mkdir()
        (orphan / f"{ATTACHMENT_ID}.png").write_bytes(b"orphan")
        original_preflight = helper._preflight_managed_directories

        def inject_after_preflight(parent_fd):
            result = original_preflight(parent_fd)
            (orphan / "unexpected-entry").write_bytes(b"race")
            return result

        with mock.patch.object(
            helper, "_preflight_managed_directories", side_effect=inject_after_preflight
        ):
            with self.assertRaises(sidecar_io.SidecarIOError):
                helper.reconcile_attachments({"referencedTaskIds": []})

        self.assertTrue(upload.is_dir(), "全树复核失败前不得先清理 staging")
        self.assertTrue(orphan.is_dir())

    @unittest.skipIf(sidecar_io.fcntl is None, "当前平台不支持 flock")
    def test_attachment_lifecycle_lock_blocks_destructive_command(self):
        helper, session, _ = self.make_bound_helper()
        task = session / "attachments" / TASK_ID
        task.mkdir()
        (task / f"{ATTACHMENT_ID}.png").write_bytes(b"keep")
        competing_fd = os.open(
            session / "attachments", os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        )
        sidecar_io.fcntl.flock(
            competing_fd, sidecar_io.fcntl.LOCK_EX | sidecar_io.fcntl.LOCK_NB
        )
        try:
            with self.assertRaises(sidecar_io.SidecarIOError) as caught:
                helper.delete_task_attachments({"taskId": TASK_ID})
        finally:
            sidecar_io.fcntl.flock(competing_fd, sidecar_io.fcntl.LOCK_UN)
            os.close(competing_fd)

        self.assertEqual(caught.exception.code, "ATTACHMENT_BUSY")
        self.assertTrue(task.is_dir())

    def test_managed_directory_rejects_injected_mount_identity_mismatch(self):
        helper, session, _ = self.make_bound_helper()
        task = session / "attachments" / TASK_ID
        task.mkdir()
        (task / f"{ATTACHMENT_ID}.png").write_bytes(b"keep")
        task_info = task.stat()
        real_mount_identity = sidecar_io._mount_identity

        def forged_mount_identity(fd):
            identity = real_mount_identity(fd)
            info = os.fstat(fd)
            if info.st_dev == task_info.st_dev and info.st_ino == task_info.st_ino:
                return (*identity, "injected-other-mount")
            return identity

        with mock.patch.object(
            sidecar_io, "_mount_identity", side_effect=forged_mount_identity
        ):
            with self.assertRaises(sidecar_io.SidecarIOError):
                helper.delete_task_attachments({"taskId": TASK_ID})

        self.assertTrue(task.is_dir())

    def test_bind_attachments_rejects_existing_mount_identity_mismatch(self):
        for level in ("attachments", "staging"):
            with self.subTest(level=level):
                helper, session, _ = self.make_bound_helper(bind_attachments=False)
                attachments = session / "attachments"
                attachments.mkdir()
                target = attachments
                if level == "staging":
                    target = attachments / ".staging"
                    target.mkdir()
                target_info = target.stat()
                real_mount_identity = sidecar_io._mount_identity

                def forged_mount_identity(fd):
                    identity = real_mount_identity(fd)
                    info = os.fstat(fd)
                    if (
                        info.st_dev == target_info.st_dev
                        and info.st_ino == target_info.st_ino
                    ):
                        return (*identity, "injected-other-mount")
                    return identity

                with mock.patch.object(
                    sidecar_io, "_mount_identity", side_effect=forged_mount_identity
                ):
                    with self.assertRaises(sidecar_io.SidecarIOError):
                        helper.bind_attachments({})

                self.assertTrue(target.is_dir())
                if level == "attachments":
                    self.assertFalse((attachments / ".staging").exists())

    def test_staged_upload_rejects_injected_mount_identity_mismatch(self):
        helper, session, _ = self.make_bound_helper()
        upload, _ = self.stage_files(session)
        upload_info = upload.stat()
        real_mount_identity = sidecar_io._mount_identity

        def forged_mount_identity(fd):
            identity = real_mount_identity(fd)
            info = os.fstat(fd)
            if info.st_dev == upload_info.st_dev and info.st_ino == upload_info.st_ino:
                return (*identity, "injected-other-mount")
            return identity

        with mock.patch.object(
            sidecar_io, "_mount_identity", side_effect=forged_mount_identity
        ):
            with self.assertRaises(sidecar_io.SidecarIOError):
                helper.discard_attachment_upload({"uploadId": UPLOAD_ID})

        self.assertTrue(upload.is_dir())

    def test_capture_directory_closes_file_fds_when_final_mount_check_fails(self):
        helper, session, _ = self.make_bound_helper()
        task = session / "attachments" / TASK_ID
        task.mkdir()
        (task / f"{ATTACHMENT_ID}.png").write_bytes(b"keep")
        task_info = task.stat()
        real_mount_identity = sidecar_io._mount_identity
        task_mount_calls = 0

        def fail_final_directory_mount_check(fd):
            nonlocal task_mount_calls
            info = os.fstat(fd)
            if info.st_dev == task_info.st_dev and info.st_ino == task_info.st_ino:
                task_mount_calls += 1
                if task_mount_calls == 3:
                    raise sidecar_io.SidecarIOError("injected mount identity failure")
            return real_mount_identity(fd)

        before = len(os.listdir("/dev/fd"))
        with mock.patch.object(
            sidecar_io,
            "_mount_identity",
            side_effect=fail_final_directory_mount_check,
        ):
            with self.assertRaises(sidecar_io.SidecarIOError):
                sidecar_io._capture_managed_attachment_directory(
                    helper.attachments_fd, TASK_ID
                )

        self.assertEqual(len(os.listdir("/dev/fd")), before)

    def test_verify_files_rejects_same_inode_entry_on_other_mount(self):
        helper, session, _ = self.make_bound_helper()
        task = session / "attachments" / TASK_ID
        task.mkdir()
        name = f"{ATTACHMENT_ID}.png"
        target = task / name
        target.write_bytes(b"keep")
        target_info = target.stat()
        directory_fd = os.open(task, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        _, opened = sidecar_io._scan_attachment_files(
            directory_fd, keep_open=True
        )
        held_fd = opened[name]["fd"]
        real_mount_identity = sidecar_io._mount_identity

        def forged_reopened_mount_identity(fd):
            identity = real_mount_identity(fd)
            info = os.fstat(fd)
            if (
                fd != held_fd
                and info.st_dev == target_info.st_dev
                and info.st_ino == target_info.st_ino
            ):
                return (*identity, "injected-bind-mount")
            return identity

        try:
            with mock.patch.object(
                sidecar_io,
                "_mount_identity",
                side_effect=forged_reopened_mount_identity,
            ):
                with self.assertRaises(sidecar_io.SidecarIOError):
                    sidecar_io._verify_open_attachment_files(directory_fd, opened)
        finally:
            os.close(held_fd)
            os.close(directory_fd)

    def test_unknown_file_open_uses_nonblock_before_fstat(self):
        helper, session, _ = self.make_bound_helper()
        task = session / "attachments" / TASK_ID
        task.mkdir()
        name = f"{ATTACHMENT_ID}.png"
        (task / name).write_bytes(b"file")
        directory_fd = os.open(task, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        real_open = sidecar_io.os.open

        def require_nonblock(path, flags, *args, **kwargs):
            if path == name and kwargs.get("dir_fd") == directory_fd:
                self.assertTrue(flags & getattr(os, "O_NONBLOCK", 0))
            return real_open(path, flags, *args, **kwargs)

        try:
            with mock.patch.object(sidecar_io.os, "open", side_effect=require_nonblock):
                sidecar_io._scan_attachment_files(directory_fd)
        finally:
            os.close(directory_fd)


if __name__ == "__main__":
    unittest.main()
