"""External SQLite reader and live Linux FD continuity check for the owned fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixture', required=True)
parser.add_argument('--evidence', required=True)
parser.add_argument('--previous')
args = parser.parse_args()
target = Path(args.evidence)
if target.exists():
    raise ValueError('New evidence file required')
fixture = json.loads(Path(args.fixture).read_text())
config = json.loads(Path(fixture['supervisor_config']).read_text())
pid = int(fixture['supervisor_pid'])
proc = Path('/proc') / str(pid)
executable = (proc / 'exe').resolve(strict=True)
binary_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
assert binary_hash == '97668cceb608e122714a8ee0be3b4da0b810d4f7507b94fd8166090f9913a29d'
journal = Path(config['data_dir']) / 'journal.db'
fds = {}
for descriptor in (proc / 'fd').iterdir():
    try:
        linked = descriptor.readlink()
    except FileNotFoundError:
        continue
    if str(linked).startswith(str(journal)):
        assert not str(linked).endswith(' (deleted)'), 'Live SQLite descriptor is unlinked'
        name = linked.name
        assert name in ('journal.db', 'journal.db-wal', 'journal.db-shm')
        actual, named = descriptor.stat(), linked.stat()
        assert actual.st_ino == named.st_ino and actual.st_dev == named.st_dev
        fds[name] = {'inode': actual.st_ino, 'device': actual.st_dev, 'links': actual.st_nlink}
        assert actual.st_nlink > 0
assert set(fds) == {'journal.db', 'journal.db-wal', 'journal.db-shm'}
# This independent CPython process includes the WAL; immutable=1 is deliberately
# absent because that would hide the live writer's committed WAL transactions.
with sqlite3.connect(journal.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
    assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    rows = db.execute('SELECT id,result FROM encrypted_host_captures ORDER BY id').fetchall()
    captures = {cid: json.loads(result)['state'] for cid, result in rows}
    operations = db.execute('SELECT id,hash,request,receipt FROM operations ORDER BY id').fetchall()
    operation_hash = hashlib.sha256(repr(operations).encode()).hexdigest()
if args.previous:
    previous = json.loads(Path(args.previous).read_text())
    assert previous['fds'] == fds, 'Named WAL/SHM inodes changed between actual captures'
    assert set(previous['captures']).issubset(captures)
    assert all(captures[cid] == state for cid, state in previous['captures'].items())
    assert previous['operation_rows_sha256'] == operation_hash
report = {'status': 'PASS', 'helper_sha256': binary_hash, 'supervisor_pid': pid,
          'quick_check': 'ok', 'external_reader_includes_wal': True, 'fds': fds,
          'captures': captures, 'operation_count': len(operations), 'operation_rows_sha256': operation_hash}
with target.open('x') as stream:
    json.dump(report, stream, indent=2)
print(json.dumps({'status': 'PASS', 'live_sqlite_descriptors_linked': True, 'quick_check': 'ok',
                  'capture_count': len(captures), 'operation_count': len(operations),
                  'previous_capture_states_and_wal_inodes_preserved': bool(args.previous)}))
