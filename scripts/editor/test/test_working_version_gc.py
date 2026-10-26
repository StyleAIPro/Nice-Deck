"""用两个真实文件后端验证回收与恢复共存，不删除任何仍被历史引用的版本。"""
import base64
import hashlib
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
import zlib
import struct
import binascii
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sidecar_io
import sidecar_io_windows

SESSION = '123e4567-e89b-42d3-a456-426614174000'


def identity(path):
    info = path.stat()
    return dict(path=str(path), realPath=str(path.resolve()), dev=str(info.st_dev), ino=str(info.st_ino))


class GCContract:
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.project = Path(tmp.name)
        self.original = b'<!doctype html><title>original</title>'
        (self.project / 'deck.html').write_bytes(self.original)
        original_hash = hashlib.sha256(self.original).hexdigest()
        name = f'deck-{original_hash[:8]}'
        self.helper = self.backend()
        self.addCleanup(self.helper.close)
        self.helper.initialize({'project': identity(self.project)})
        self.helper.ensure_root({})
        self.helper.prepare_session(dict(deckName='deck.html', sessionId=SESSION,
                                        initialFingerprint=original_hash, sessionName=name, mode='fresh'))
        self.helper.bind_session(dict(deckName='deck.html', sessionId=SESSION, sessionName=name, create=True))
        self.directory = self.project / '.aico-ppt-editor' / name
        self.versions = self.directory / 'working' / 'versions'
        self.hashes = []
        previous = None
        old = time.time() - 7 * 86400
        for i in range(20):
            data = f'<!doctype html><title>version {i}</title>'.encode()
            result = self.helper.write_working_deck(dict(sessionId=SESSION,
                bytes=base64.b64encode(data).decode(), expectedFingerprint=previous))
            previous = result['fingerprint']
            self.hashes.append(previous)
            os.utime(self.versions / f'{previous}.html', (old + i, old + i))
        self.state = dict(version=2, sessionId=SESSION, workingDeckFingerprint=previous,
                          deckFingerprint=original_hash, deckPath=str(self.project / 'deck.html'), timeline={'entries':[], 'cursor':0},
                          groups=[], redo=[], checkpoints=[], historyArchives=[])
        self.persist()

    def persist(self):
        self.helper.write_session(dict(sessionId=SESSION, bytes=base64.b64encode(json.dumps(self.state).encode()).decode()))

    def prune(self, dry=False):
        return self.helper.prune_working_versions({'dryRun':dry})

    def test_reclaims_real_archives_but_keeps_every_reference_and_restore_works(self):
        for index, field in enumerate(['groups', 'redo', 'checkpoints', 'historyArchives']):
            self.state[field] = [{'source':{'beforeFingerprint':self.hashes[index]}}]
        self.state['completedCommands'] = {'command':{'result':{'afterFingerprint':self.hashes[4]}}}
        self.state['timeline']['entries'] = [{'source':{'afterFingerprint':self.hashes[5]}}]
        (self.directory / 'backups' / f'deck-{self.hashes[6]}.html').write_bytes(b'backup')
        (self.directory / 'agent-workspace.json').write_text(json.dumps({'context':self.hashes[7]}))
        self.persist()
        protected = {p: p.read_bytes() for p in [self.directory / 'session.json',
            self.directory / 'working' / 'deck.html', self.project / 'deck.html']}
        preview = self.prune(True)
        self.assertEqual(preview['removed'], 0)
        self.assertEqual(preview['candidateBytes'], sum((self.versions / name).stat().st_size for name in preview['candidates']))
        result = self.prune()
        self.assertEqual(result['removed'], 4)
        for i, digest in enumerate(self.hashes):
            self.assertEqual((self.versions / f'{digest}.html').exists(), i < 8 or i >= 12)
        for path, content in protected.items():
            self.assertEqual(path.read_bytes(), content)
        restored = self.helper.restore_working_deck(dict(
            fingerprint=self.hashes[0], expectedFingerprint=self.hashes[-1]))
        self.assertEqual(restored['fingerprint'], self.hashes[0])

    def test_second_cleaner_cannot_enter_an_active_project(self):
        other = self.backend()
        self.addCleanup(other.close)
        with self.assertRaises(sidecar_io.SidecarIOError):
            other.initialize({'project':identity(self.project),
                              'root':identity(self.directory.parent)})
        self.assertEqual(len(list(self.versions.iterdir())), 20)

    def test_cli_previews_then_applies_with_a_receipt(self):
        import subprocess
        self.helper.close()
        command = [sys.executable, '-X', 'utf8',
                   str(Path(__file__).resolve().parents[1] / 'prune-working-versions.py'),
                   str(self.directory)]
        preview = subprocess.run(command, check=True, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(json.loads(preview.stdout)['removed'], 0)
        self.assertEqual(len(list(self.versions.iterdir())), 20)
        receipt = self.project / 'receipt.json'
        applied = subprocess.run(command + ['--apply', '--report', str(receipt)],
                                 check=True, capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(json.loads(applied.stdout)['removed'], 12)
        self.assertEqual(json.loads(receipt.read_text(encoding='utf-8'))['result']['removed'], 12)
        self.assertEqual(len(list(self.versions.iterdir())), 8)

    def test_recent_versions_are_protected_even_if_unreferenced(self):
        os.utime(self.versions / f'{self.hashes[0]}.html', None)
        self.prune()
        self.assertTrue((self.versions / f'{self.hashes[0]}.html').exists())

    def solidified(self):
        current=(self.directory/'working'/'deck.html').read_bytes()
        (self.project/'deck.html').write_bytes(current)
        backup_hash=hashlib.sha256(self.original).hexdigest()
        self.backup_name=f'deck-{backup_hash}.html'
        (self.directory/'backups'/self.backup_name).write_bytes(self.original)
        self.state['deckFingerprint']=self.hashes[-1]
        self.state['checkpoints']=[{'checkpointId':'checkpoint-one','fingerprint':self.hashes[-1]}]
        self.state['historyRetention']={'version':1,'checkpointId':'checkpoint-one',
            'fingerprint':self.hashes[-1],'backupFingerprint':backup_hash}
        self.state['historyArchives']=[{'format':'audit-v1','entries':[]}]
        self.persist()

    def test_solidified_reclaims_recent_intermediate_html_and_rotates_verified_backups(self):
        self.solidified()
        for name in self.versions.iterdir():os.utime(name,None)
        old_bytes=b'previous published deck';old_hash=hashlib.sha256(old_bytes).hexdigest()
        stale=self.directory/'backups'/f'deck-{old_hash}.html';stale.write_bytes(old_bytes)
        unknown=self.directory/'backups'/'user-copy.html';unknown.write_bytes(b'keep')
        self.state['timeline']={'entries':[{'source':{'beforeFingerprint':self.hashes[0]}}],'cursor':1}
        self.persist()
        result=self.prune()
        self.assertEqual(set(p.name for p in self.versions.iterdir()),{f'{self.hashes[0]}.html',f'{self.hashes[-1]}.html'})
        self.assertEqual(result['removed'],18)
        self.assertEqual(result['removedBackups'],1)
        self.assertTrue((self.directory/'backups'/self.backup_name).exists())
        self.assertTrue(unknown.exists())
        self.assertEqual((self.project/'deck.html').read_bytes(),(self.directory/'working'/'deck.html').read_bytes())

    def test_solidified_missing_backup_or_unfinished_transaction_cannot_delete_history(self):
        self.solidified()
        (self.directory/'backups'/self.backup_name).unlink()
        self.assertEqual(self.prune()['skipped'],'solidified-backup-unavailable')
        self.assertEqual(len(list(self.versions.iterdir())),20)

    def test_solidified_external_source_change_and_unknown_old_archives_are_protected(self):
        self.solidified()
        self.state['historyArchives'].append({'source':{'beforeFingerprint':self.hashes[2]}})
        self.persist()
        self.prune()
        self.assertTrue((self.versions/f'{self.hashes[2]}.html').exists())
        (self.project/'deck.html').write_bytes(b'external changed')
        self.assertEqual(self.prune()['skipped'],'published-deck-changed')

    def test_one_hundred_edits_and_ten_real_publications_have_bounded_storage(self):
        # 真实发布、事务持久化和清理均走正式后端；不以手写 marker 代替成功发布。
        current=self.hashes[-1]
        payload=b'x'*65536
        if os.environ.get('AICO_GC_LARGE_IMAGE') == '1':
            def chunk(kind,data):
                return struct.pack('!I',len(data))+kind+data+struct.pack('!I',binascii.crc32(kind+data)&0xffffffff)
            pixels=b''.join(b'\0'+os.urandom(1024*3) for _ in range(1024))
            png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!IIBBBBB',1024,1024,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
            payload=b'<img src="data:image/png;base64,'+base64.b64encode(png)+b'">'
        curve=[]
        for batch in range(10):
            old_source=(self.project/'deck.html').read_bytes()
            old_fingerprint=hashlib.sha256(old_source).hexdigest()
            for edit in range(10):
                content=f'<!doctype html><title>{batch}-{edit}</title>'.encode()+payload
                current=self.helper.write_working_deck(dict(sessionId=SESSION,
                    bytes=base64.b64encode(content).decode(),expectedFingerprint=current))['fingerprint']
            operation=str(uuid.uuid4())
            self.helper.publish_working_deck(dict(sessionId=SESSION,transactionId=operation,
                expectedDeckFingerprint=old_fingerprint,expectedWorkingFingerprint=current))
            self.assertEqual(self.prune()['skipped'],'transactions-present')
            self.state.update(deckFingerprint=current,workingDeckFingerprint=current,
                checkpoints=[{'checkpointId':operation,'fingerprint':current}],
                historyArchives=[{'format':'audit-v1','entries':[]}],
                historyRetention={'version':1,'checkpointId':operation,
                    'fingerprint':current,'backupFingerprint':old_fingerprint})
            self.persist()
            self.helper.delete_transaction({'transactionId':operation})
            self.prune()
            self.assertEqual(len(list(self.versions.iterdir())),1)
            backups=list((self.directory/'backups').glob('*.html'))
            self.assertEqual(len(backups),1)
            self.assertEqual(backups[0].read_bytes(),old_source)
            self.assertEqual((self.project/'deck.html').read_bytes(),content)
            curve.append({'publication':batch+1,'deckBytes':len(content),'versions':len(list(self.versions.iterdir())),
                          'backups':len(backups),'versionBytes':sum(p.stat().st_size for p in self.versions.iterdir()),
                          'backupBytes':sum(p.stat().st_size for p in backups)})
        if os.environ.get('AICO_GC_STRESS_REPORT'):
            report=Path(os.environ['AICO_GC_STRESS_REPORT']);report.mkdir(parents=True,exist_ok=True)
            (report/f'{os.name}-{type(self).__name__}.json').write_text(json.dumps(curve,indent=2),encoding='utf-8')

    def test_pending_source_edit_transaction_and_uncheckpointed_bytes_skip(self):
        self.state['sourceEdit'] = {'beforeFingerprint':self.hashes[0]}
        self.persist()
        self.assertEqual(self.prune()['skipped'], 'session-not-settled')
        del self.state['sourceEdit']; self.persist()
        tx = self.directory / 'transactions' / 'pending.json'
        tx.write_text('{}')
        self.assertEqual(self.prune()['skipped'], 'transactions-present')
        tx.unlink()
        (self.directory / 'working' / 'deck.html').write_bytes(b'not checkpointed')
        self.assertEqual(self.prune()['skipped'], 'working-checkpoint-pending')
        self.assertEqual(len(list(self.versions.iterdir())), 20)

    def test_corrupt_metadata_fails_before_any_deletion(self):
        (self.directory / 'session.json').write_text('{')
        with self.assertRaises(sidecar_io.SidecarIOError):
            self.prune()
        self.assertEqual(len(list(self.versions.iterdir())), 20)

    def test_metadata_change_during_gc_stops_before_unlink(self):
        import working_version_gc
        real_clock = working_version_gc.time.time_ns
        def change_metadata():
            self.state['groups'] = [{'source':{'beforeFingerprint':self.hashes[0]}}]
            self.persist()
            return real_clock()
        with mock.patch.object(working_version_gc.time, 'time_ns', side_effect=change_metadata):
            with self.assertRaises(sidecar_io.SidecarIOError):
                self.prune()
        self.assertEqual(len(list(self.versions.iterdir())), 20)

    def test_symlink_version_cannot_redirect_gc(self):
        path = self.versions / f'{self.hashes[0]}.html'
        path.unlink()
        try:
            path.symlink_to(self.project / 'deck.html')
        except OSError:
            self.skipTest('当前 Windows 用户不能创建符号链接')
        with self.assertRaises(sidecar_io.SidecarIOError):
            self.prune()
        self.assertEqual((self.project / 'deck.html').read_bytes(), self.original)
        self.assertEqual(len(list(self.versions.iterdir())), 20)


@unittest.skipIf(os.name == 'nt', 'POSIX dirfd 后端')
class PosixGC(GCContract, unittest.TestCase):
    backend = sidecar_io.PersistentHelper


class WindowsGC(GCContract, unittest.TestCase):
    backend = sidecar_io_windows.WindowsPersistentHelper


if __name__ == '__main__':
    unittest.main()
