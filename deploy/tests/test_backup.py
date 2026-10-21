import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location('backup', Path(__file__).parents[1] / 'backup.py')
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)
sys.path.insert(0, str(Path(__file__).parents[1]))
from restore import extract


class BackupTests(unittest.TestCase):
    def test_sqlite_wal_snapshot_is_consistent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with closing(sqlite3.connect(root / 'live.db')) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE operations(id TEXT PRIMARY KEY)')
                db.execute("INSERT INTO operations VALUES('one')")
                db.commit()
                backup.sqlite_snapshot(root / 'live.db', root / 'snapshot.db')
                with closing(sqlite3.connect(root / 'snapshot.db')) as snapshot:
                    self.assertEqual(snapshot.execute('SELECT id FROM operations').fetchall(), [('one',)])

    def test_offline_project_is_incomplete_and_corruption_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'artifacts'
            source.mkdir()
            (source / 'output.bin').write_bytes(b'\x00\x10\xff')
            inventory = root / 'inventory.json'
            inventory.write_text(json.dumps({'components': [
                {'id': 'artifacts', 'kind': 'artifacts', 'source': str(source), 'consistent': True, 'capture_evidence': 'test'},
                {'id': 'offline', 'kind': 'project', 'source': str(root / 'missing'), 'consistent': True, 'capture_evidence': 'test'}]}))
            self.assertEqual(backup.stage(SimpleNamespace(inventory=inventory, output=root / 'set')), 2)
            manifest = backup.verify(root / 'set')
            self.assertEqual(manifest['status'], 'INCOMPLETE')
            (root / 'set' / 'artifacts.tar.gz').write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                backup.verify(root / 'set')

    def test_capture_and_restore_reject_links_and_traversal(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as stream:
                member = tarfile.TarInfo('../outside')
                member.size = 1
                stream.addfile(member, io.BytesIO(b'x'))
            with self.assertRaises(ValueError):
                extract(archive, root / 'restored')
            self.assertFalse((root / 'outside').exists())

    def test_binary_and_dotfiles_survive_archive_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'source'
            source.mkdir()
            (source / '.instructions').write_text('retained')
            (source / 'result.bin').write_bytes(bytes(range(256)))
            backup.archive_tree(source, root / 'files.tar.gz')
            extract(root / 'files.tar.gz', root / 'restored')
            self.assertEqual(backup.sha(source / 'result.bin'), backup.sha(root / 'restored/result.bin'))
            self.assertEqual((root / 'restored/.instructions').read_text(), 'retained')

    def test_database_inventory_catches_omitted_remote_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            expected = root / 'database-inventory.json'
            expected.write_text(json.dumps({'workspaces': [{'id': 'offline-project'}], 'machines': [{'id': 'offline-host'}]}))
            inventory = root / 'inventory.json'
            inventory.write_text(json.dumps({'database_inventory_file': str(expected), 'components': []}))
            self.assertEqual(backup.stage(SimpleNamespace(inventory=inventory, output=root / 'set')), 2)
            manifest = backup.verify(root / 'set')
            self.assertIn('Uncovered registered workspace: offline-project', manifest['gaps'])
            self.assertIn('Uncovered host ledger: offline-host', manifest['gaps'])

    def test_archive_count_and_pax_metadata_are_bounded_before_extract(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with tarfile.open(root/'many.tar.gz','w:gz') as archive:
                for i in range(4):
                    member=tarfile.TarInfo(str(i));member.size=1;archive.addfile(member,io.BytesIO(b'x'))
            with self.assertRaisesRegex(ValueError,'entry/expanded-byte'):
                extract(root/'many.tar.gz',root/'many-output',max_entries=3)
            self.assertFalse((root/'many-output').exists())
            with tarfile.open(root/'pax.tar.gz','w:gz') as archive:
                member=tarfile.TarInfo('pax');member.type=tarfile.XHDTYPE;member.size=65537
                archive.addfile(member,io.BytesIO(b' ' * member.size))
            with self.assertRaisesRegex(ValueError,'PAX metadata'):
                extract(root/'pax.tar.gz',root/'pax-output')
            self.assertFalse((root/'pax-output').exists())

    def test_captured_component_must_be_in_hash_map(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            (root/'manifest.json').write_text(json.dumps({'components':[{'id':'database','kind':'postgres','status':'CAPTURED','file':'outside.bin','sha256':'0'*64}],'files':{}}))
            with self.assertRaisesRegex(ValueError,'absent from integrity map'):
                backup.verify(root)


if __name__ == '__main__':
    unittest.main()
