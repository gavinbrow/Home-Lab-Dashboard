"""Offline, explicit-coverage backup staging and integrity verification (Python 3.12+)."""
import argparse
from contextlib import closing
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def sqlite_snapshot(source, target):
    source = Path(source).resolve(strict=True)
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src:
        with closing(sqlite3.connect(target)) as dst:
            src.backup(dst)
            dst.commit()
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('SQLite integrity check failed')


def archive_tree(source, target):
    source = Path(source).resolve(strict=True)
    if not source.is_dir():
        raise ValueError('Capture source must be a directory')
    with tarfile.open(target, 'w:gz', dereference=True) as archive:
        for path in sorted(source.rglob('*')):
            if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
                raise ValueError('Links/reparse points require a separate native backup adapter')
            if not path.is_file() and not path.is_dir():
                raise ValueError('Special files require a native backup adapter')
            archive.add(path, arcname=path.relative_to(source).as_posix(), recursive=False)


def stage(args):
    inventory = json.loads(Path(args.inventory).read_text(encoding='utf-8-sig'))
    destination = Path(args.output).resolve()
    destination.mkdir(parents=True, exist_ok=False)
    os.chmod(destination, 0o700)
    set_id=inventory.get('backup_set_id',destination.name)
    if not isinstance(set_id,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',set_id):
        raise ValueError('Invalid backup set identity')
    manifest = {'schema_version': 1, 'backup_set_id': set_id,
                'created_at': dt.datetime.now(dt.timezone.utc).isoformat(),
                'status': 'INCOMPLETE', 'encrypted': False, 'components': [],
                'gaps': [], 'inventory': inventory, 'files': {}}
    # Inventory attestation is deliberately separate from transport success.
    for field in ('database_inventory_evidence', 'quiescence_evidence', 'key_recovery_evidence', 'software_version_evidence'):
        if not inventory.get(field):
            manifest['gaps'].append('Missing ' + field)
    components = inventory.get('components', [])
    # Compare against a database export, not just a user-entered list of reachable hosts.
    expected = inventory.get('database_inventory_file')
    if expected:
        expected = json.loads(Path(expected).read_text(encoding='utf-8-sig'))
        manifest['database_inventory'] = expected
        for workspace in expected['workspaces']:
            if not any(item.get('required', True) and ((item.get('workspace_id') == workspace['id'] and item['kind'] == 'project') or
                    (item['kind'] == 'host-state' and item.get('machine_id') == workspace['machine_id'] and item.get('consistent') and workspace['id'] in item.get('workspace_ids', []))) for item in components):
                manifest['gaps'].append('Uncovered registered workspace: ' + workspace['id'])
        for machine in expected['machines']:
            if not any(item.get('machine_id') == machine['id'] and item.get('required', True) and (item['kind'] == 'sqlite' or
                    (item['kind'] == 'host-state' and item.get('consistent') and item.get('covers_journal'))) for item in components):
                manifest['gaps'].append('Uncovered host ledger: ' + machine['id'])
    else:
        manifest['gaps'].append('Missing authoritative database_inventory_file')
    ids = [item['id'] for item in components]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate component IDs')
    for kind in ('postgres', 'artifacts', 'keys', 'ca'):
        if not any(item['kind'] == kind and item.get('required', True) for item in components):
            manifest['gaps'].append('Missing required component kind: ' + kind)
    for item in components:
        cid = item['id']
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', cid):
            raise ValueError('Invalid component ID')
        result = {'id': cid, 'kind': item['kind'], 'status': 'INCOMPLETE'}
        result['consistency'] = 'quiesced' if item.get('consistent') else 'best_effort'
        for field in ('workspace_id', 'workspace_ids', 'machine_id', 'capture_evidence', 'consistency', 'boot_id', 'environment_generation', 'checkpoint_id', 'covers_journal', 'coverage', 'encrypted'):
            if field in item:
                result[field] = item[field]
        try:
            if not item.get('capture_evidence'):
                raise ValueError('No capture evidence')
            if not item.get('consistent') and item.get('required', True):
                manifest['gaps'].append(cid + ': capture is not application-consistent')
            source = Path(item['source']).resolve(strict=True)
            if destination == source or source in destination.parents:
                raise ValueError('Backup staging must be outside capture source')
            if item['kind'] == 'sqlite':
                output = destination / (cid + '.sqlite')
                sqlite_snapshot(source, output)
            elif source.is_dir():
                output = destination / (cid + '.tar.gz')
                archive_tree(source, output)
            else:
                output = destination / (cid + '.bin')
                shutil.copyfile(source, output)
            result.update(status='CAPTURED', file=output.name, sha256=sha(output))
            manifest['files'][output.name] = result['sha256']
        except (OSError, ValueError, sqlite3.Error) as exc:
            result['reason'] = str(exc)
            if item.get('required', True):
                manifest['gaps'].append(cid + ': ' + str(exc))
        manifest['components'].append(result)
    manifest['status'] = 'STAGED' if not manifest['gaps'] else 'INCOMPLETE'
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps({'backup_set_id': destination.name, 'status': manifest['status'],
                      'gaps': manifest['gaps'], 'encrypted': False}))
    return 2 if manifest['gaps'] else 0


def verify(directory):
    directory = Path(directory).resolve(strict=True)
    manifest = json.loads((directory / 'manifest.json').read_text())
    seen = set()
    for component in manifest['components']:
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', component['id']) or component['id'].casefold() in seen:
            raise ValueError('Unsafe or duplicate component ID')
        seen.add(component['id'].casefold())
        if component['status'] == 'CAPTURED':
            name = component['file']
            if name not in manifest['files'] or component['sha256'] != manifest['files'][name]:
                raise ValueError('Captured component absent from integrity map')
    captured = [c['file'] for c in manifest['components'] if c['status'] == 'CAPTURED']
    if len(captured) != len(set(captured)) or set(captured) != set(manifest['files']):
        raise ValueError('Unexpected or duplicate integrity-map entry')
    for name, digest in manifest['files'].items():
        if Path(name).name != name or sha(directory / name) != digest:
            raise ValueError('Missing or corrupt component: ' + name)
    return manifest


def seal(args):
    manifest = verify(args.directory)
    # Password/repository are supplied only through restic's protected environment/files.
    if not os.environ.get('RESTIC_REPOSITORY') or not os.environ.get('RESTIC_PASSWORD_FILE'):
        raise ValueError('RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE are required')
    binary = getattr(args, 'restic_binary', None) or os.environ.get('RESTIC_BINARY', 'restic')
    version = subprocess.check_output([binary, 'version'], text=True)
    if not version.startswith('restic 0.18.1 '):
        raise ValueError('Reviewed restic 0.18.1 required')
    receipt = Path(getattr(args, 'receipt', None) or (str(Path(args.directory).resolve()) + '.seal.json'))
    if receipt.exists():
        raise ValueError('Seal receipt target must be new')
    result = subprocess.run([binary, 'backup', '--json', '--tag', manifest['backup_set_id'],
                    str(Path(args.directory).resolve())], check=True, capture_output=True, text=True)
    summary = next((json.loads(line) for line in result.stdout.splitlines() if json.loads(line).get('message_type') == 'summary'), None)
    if not summary or not summary.get('snapshot_id'):
        raise ValueError('No durable restic snapshot ID returned')
    subprocess.run([binary, 'check', '--read-data'], check=True, capture_output=True, text=True)
    receipt.write_text(json.dumps({'schema_version': 1, 'backup_set_id': manifest['backup_set_id'],
        'snapshot_id': summary['snapshot_id'], 'manifest_sha256': sha(Path(args.directory) / 'manifest.json'),
        'coverage': manifest['status'], 'encrypted': True, 'repository_read_check': 'PASS',
        'created_at': dt.datetime.now(dt.timezone.utc).isoformat()}, indent=2), encoding='utf-8')
    print(json.dumps({'status': 'SEALED' if manifest['status'] == 'STAGED' else 'INCOMPLETE',
                      'backup_set_id': manifest['backup_set_id'], 'restore_drill': 'NOT RUN'}))
    return 0 if manifest['status'] == 'STAGED' else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    capture = sub.add_parser('stage')
    capture.add_argument('--inventory', required=True)
    capture.add_argument('--output', required=True)
    integrity = sub.add_parser('verify')
    integrity.add_argument('directory')
    encrypt = sub.add_parser('seal')
    encrypt.add_argument('directory')
    encrypt.add_argument('--restic-binary')
    encrypt.add_argument('--receipt')
    snapshot = sub.add_parser('sqlite')
    snapshot.add_argument('source')
    snapshot.add_argument('target')
    args = parser.parse_args()
    if args.command == 'stage':
        return stage(args)
    if args.command == 'seal':
        return seal(args)
    if args.command == 'sqlite':
        if Path(args.target).exists():
            raise ValueError('Snapshot target must be new')
        sqlite_snapshot(args.source, args.target)
        return 0
    manifest = verify(args.directory)
    print(json.dumps({'integrity': 'PASS', 'coverage': manifest['status']}))
    return 0 if manifest['status'] == 'STAGED' else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.CalledProcessError, sqlite3.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
