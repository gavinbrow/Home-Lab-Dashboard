"""Loopback-only PostgreSQL component capture/restore for isolated development drills."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pg-bin', required=True)
parser.add_argument('--connection-file', required=True, help='Protected JSON containing databaseUrl; never printed')
sub = parser.add_subparsers(dest='command', required=True)
capture = sub.add_parser('capture')
capture.add_argument('--dump', required=True)
restore = sub.add_parser('restore')
restore.add_argument('--dump', required=True)
restore.add_argument('--target-database', required=True)
args = parser.parse_args()
url = urlparse(json.loads(Path(args.connection_file).read_text())['databaseUrl'])
if url.hostname not in ('127.0.0.1', 'localhost', '::1'):
    parser.error('Native component drill accepts only loopback PostgreSQL')
env = os.environ.copy()
env.update(PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGUSER=unquote(url.username or ''),
           PGPASSWORD=unquote(url.password or ''), PGDATABASE=unquote(url.path.lstrip('/')))
bin_dir = Path(args.pg_bin)


def command(name, parameters, **kwargs):
    return subprocess.run([str(bin_dir / name)] + parameters, env=env, check=True, **kwargs)


def sql(query):
    return command('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', query], capture_output=True, text=True).stdout.strip()


dump = Path(args.dump).resolve()
if args.command == 'capture':
    with dump.open('xb') as output:
        command('pg_dump', ['-Fc', '--no-owner', '--no-acl'], stdout=output)
    print(json.dumps({'database_capture': 'CAPTURED', 'scope': 'metadata only; project/key coverage INCOMPLETE'}))
else:
    if not re.fullmatch(r'homelab_restore_[a-z0-9_]{1,48}', args.target_database):
        parser.error('New database name must start homelab_restore_')
    # CREATE DATABASE without IF NOT EXISTS intentionally refuses any existing target.
    sql('CREATE DATABASE "' + args.target_database + '"')
    env['PGDATABASE'] = args.target_database
    with dump.open('rb') as source:
        command('pg_restore', ['--dbname', args.target_database, '--no-owner', '--no-acl', '--exit-on-error'], stdin=source)
    old_epoch = sql('SELECT dispatch_epoch FROM runtime_control WHERE singleton')
    sql(Path(__file__).with_name('restore-fence.sql').read_text(encoding='utf-8'))
    result = json.loads(sql("SELECT json_build_object('dispatch_enabled',dispatch_enabled,'restore_mode',restore_mode,'dispatch_epoch',dispatch_epoch) FROM runtime_control WHERE singleton"))
    result['epoch_rotated'] = result['dispatch_epoch'] != old_epoch
    result['restored_rows'] = json.loads(sql("SELECT json_build_object('users',(SELECT count(*) FROM users),'machines',(SELECT count(*) FROM machines),'jobs',(SELECT count(*) FROM jobs),'operations',(SELECT count(*) FROM operations))"))
    result['historical_jobs_matching_new_epoch'] = int(sql('SELECT count(*) FROM jobs j JOIN runtime_control r ON j.dispatch_epoch=r.dispatch_epoch WHERE r.singleton'))
    result['historical_queued_jobs_retained'] = int(sql("SELECT count(*) FROM jobs WHERE state='queued'"))
    result['scope'] = 'PostgreSQL component only; no API/worker started; files/keys/hosts not restored'
    print(json.dumps(result))
