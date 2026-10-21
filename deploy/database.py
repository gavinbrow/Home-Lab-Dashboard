"""Compose PostgreSQL capture/isolated restore with explicit stopped-runtime checks."""
import argparse
import json
from pathlib import Path
import re
import subprocess

REPO = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--database', default='homelab')
    sub = parser.add_subparsers(dest='command', required=True)
    capture = sub.add_parser('capture')
    capture.add_argument('--output', required=True)
    capture.add_argument('--allow-running-service', action='append', default=[], help='Explicit independently quiesced non-writer service; never api/worker/proxy')
    restore = sub.add_parser('restore')
    restore.add_argument('--dump', required=True)
    restore.add_argument('--isolated-drill', action='store_true', required=True)
    args = parser.parse_args()
    compose = ['docker', 'compose', '--env-file', str(Path(args.env_file).resolve()),
               '-p', args.project, '-f', str(REPO / 'deploy/compose.yml')]
    running = subprocess.check_output(compose + ['ps', '--status', 'running', '--services'], text=True).split()
    allowed = set(getattr(args, 'allow_running_service', []))
    if allowed & {'api', 'worker', 'proxy'}:
        parser.error('Application writers cannot be excluded from the stopped-runtime check')
    if set(running) - {'postgres'} - allowed:
        parser.error('Only postgres may run during a database capture/restore; stop API, worker, proxy and all other services')
    if 'postgres' not in running:
        parser.error('Start only postgres before using this command')
    psql = compose + ['exec', '-T', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', args.database]
    if args.command == 'capture':
        output = Path(args.output).resolve()
        output.mkdir(mode=0o700, parents=True, exist_ok=False)
        # Stop API/worker and drain hosts first. Capture refuses mutations still in progress.
        active = subprocess.check_output(psql + ['-At', '-c', "SELECT count(*) FROM operations WHERE status NOT IN ('succeeded','failed','cancelled','rejected')"], text=True).strip()
        if active != '0':
            parser.error('Unresolved operations exist: reconcile/drain or explicitly record an incomplete backup outside this command')
        with (output / 'database.dump').open('wb') as target:
            subprocess.run(compose + ['exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', args.database, '-Fc', '--no-owner', '--no-acl'], stdout=target, check=True)
        query = "SELECT json_build_object('workspaces',(SELECT coalesce(json_agg(json_build_object('id',id,'machine_id',machine_id,'canonical_root',canonical_root,'state',state)),'[]') FROM workspaces WHERE state <> 'unregistered'),'machines',(SELECT coalesce(json_agg(json_build_object('id',id,'name',name)),'[]') FROM machines),'dispatch',(SELECT row_to_json(r) FROM runtime_control r WHERE singleton))"
        inventory = subprocess.check_output(psql + ['-At', '-c', query], text=True)
        json.loads(inventory)
        (output / 'database-inventory.json').write_text(inventory, encoding='utf-8')
        print('CAPTURED database and authoritative inventory; project/host/key coverage remains separate')
        return
    if not re.fullmatch(r'homelab-restore-[a-z0-9-]+', args.project):
        parser.error('Restore project must start homelab-restore- and use a NEW isolated configuration/root')
    env_path = Path(args.env_file).resolve(strict=True)
    values = dict(line.split('=', 1) for line in env_path.read_text().splitlines() if line and not line.startswith('#'))
    if (values.get('RESTORE_MODE') != 'true' or
            Path(values.get('DATA_DIR', '')).resolve() != env_path.parent / 'data' or
            not (env_path.parent / 'ISOLATED_RESTORE_DRILL').is_file()):
        parser.error('Use configure.py --restore-drill with its original isolated compose.env')
    count = subprocess.check_output(psql + ['-At', '-c', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"], text=True).strip()
    if count != '0':
        parser.error('Restore requires an empty database; existing databases are never overwritten')
    with Path(args.dump).open('rb') as source:
        subprocess.run(compose + ['exec', '-T', 'postgres', 'pg_restore', '-U', 'postgres', '-d', args.database, '--exit-on-error', '--no-owner', '--no-acl'], stdin=source, check=True)
    fence = (Path(__file__).with_name('restore-fence.sql')).read_text(encoding='utf-8')
    result = subprocess.check_output(psql + ['-At', '-c', fence], text=True)
    print(result)
    print('RESTORED and FENCED; API/worker remain stopped. Reconcile hosts before any new dispatch.')


if __name__ == '__main__':
    main()
