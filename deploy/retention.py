"""Plan exact-snapshot retirement; preserve protected/unregistered recovery sets.

This deliberately does not prune repository data or remove plaintext staging.
Run only during an operator-controlled repository maintenance window.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def instant(value):
    result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Retention times require a timezone')
    return result


def run(binary, *args):
    return subprocess.check_output([binary, *args], text=True, stderr=subprocess.PIPE)


def repository(binary):
    if not os.environ.get('RESTIC_REPOSITORY') or not os.environ.get('RESTIC_PASSWORD_FILE'):
        raise ValueError('Protected RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE required')
    if not run(binary, 'version').startswith('restic 0.18.1 '):
        raise ValueError('Reviewed restic0.18.1 required')
    config = json.loads(run(binary, 'cat', 'config'))
    snapshots = json.loads(run(binary, 'snapshots', '--json')) or []
    return config['id'], snapshots


def registry(path):
    value = json.loads(Path(path).read_text())
    if set(value) != {'schema_version', 'snapshots'} or value['schema_version'] != 1:
        raise ValueError('Unsupported retention registry')
    result = {}
    for entry in value['snapshots']:
        if set(entry) != {'snapshot_id', 'retain_until', 'protected', 'restore_verified', 'retirement_approved'}:
            raise ValueError('Unexpected retention entry fields')
        sid = entry['snapshot_id']
        if not re.fullmatch('[0-9a-f]{64}', sid) or sid in result:
            raise ValueError('Full unique snapshot IDs required')
        for key in ('protected', 'restore_verified', 'retirement_approved'):
            if type(entry[key]) is not bool:
                raise ValueError('Explicit boolean retention decisions required')
        instant(entry['retain_until'])
        result[sid] = entry
    return result


def decisions(snapshots, entries, now):
    ids = {item['id'] for item in snapshots}
    if not set(entries).issubset(ids):
        raise ValueError('Registry references absent snapshots; reconcile before retirement')
    protected = {sid for sid, entry in entries.items() if entry['protected']}
    if not any(entry['protected'] and entry['restore_verified'] for entry in entries.values()):
        raise ValueError('At least one protected, restore-verified snapshot required')
    newest = max(snapshots, key=lambda item: instant(item['time']))['id'] if snapshots else None
    removed = sorted(sid for sid, entry in entries.items()
                     if sid not in protected and sid != newest and entry['retirement_approved']
                     and instant(entry['retain_until']) <= now)
    return removed, sorted(ids - set(removed))


def exclusive_json(path, value):
    with Path(path).open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'apply'])
    parser.add_argument('--registry', required=True, help='Protected operator-maintained recovery register')
    parser.add_argument('--plan', required=True, help='New plan for plan; existing reviewed plan for apply')
    parser.add_argument('--restic-binary', default=os.environ.get('RESTIC_BINARY', 'restic'))
    parser.add_argument('--approve-plan-sha256')
    parser.add_argument('--receipt')
    parser.add_argument('--repository-quiesced', action='store_true')
    args = parser.parse_args()
    repo_id, snapshots = repository(args.restic_binary)
    entries = registry(args.registry)
    now = dt.datetime.now(dt.timezone.utc)
    remove, keep = decisions(snapshots, entries, now)
    state = {'repository_id': repo_id, 'snapshot_ids': sorted(item['id'] for item in snapshots),
             'registry_sha256': digest(args.registry), 'remove': remove, 'keep': keep}
    if args.command == 'plan':
        exclusive_json(args.plan, {'schema_version': 1, **state, 'created_at': now.isoformat(),
                                  'expires_at': (now + dt.timedelta(hours=1)).isoformat()})
        print(json.dumps({'plan_sha256': digest(args.plan), 'retire_count': len(remove), 'retain_count': len(keep)}))
        return
    if not args.repository_quiesced or not args.receipt:
        raise ValueError('Apply requires an explicit quiesced repository and new receipt path')
    if not args.approve_plan_sha256 or digest(args.plan) != args.approve_plan_sha256:
        raise ValueError('Reviewed plan SHA256 must match exactly')
    plan = json.loads(Path(args.plan).read_text())
    if plan.get('schema_version') != 1 or instant(plan['expires_at']) <= now:
        raise ValueError('Plan is expired or unsupported')
    if any(plan.get(key) != value for key, value in state.items()):
        raise ValueError('Repository or recovery register changed; create a new plan')
    # Claim receipt before any deletion, so retries cannot silently repeat an
    # ambiguous retirement. Preserve a failed receipt for manual reconciliation.
    exclusive_json(args.receipt, {'status': 'started', 'plan_sha256': args.approve_plan_sha256, **state})
    run(args.restic_binary, 'check', '--read-data')
    if remove:
        run(args.restic_binary, 'forget', *remove)
    run(args.restic_binary, 'check', '--read-data')
    _, final_snapshots = repository(args.restic_binary)
    if sorted(item['id'] for item in final_snapshots) != keep:
        raise ValueError('Unexpected repository state; preserve receipt and reconcile')
    Path(args.receipt).write_text(json.dumps({'status': 'forgotten', 'plan_sha256': args.approve_plan_sha256,
        **state, 'repository_read_check': 'PASS', 'data_pruned': False}, indent=2), encoding='utf8')
    print(json.dumps({'retired': len(remove), 'retained': len(keep), 'repository_read_check': 'PASS', 'data_pruned': False}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
