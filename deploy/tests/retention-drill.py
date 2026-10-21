"""Tiny isolated real-restic retention rehearsal; never accepts an existing repo."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--restic-binary', required=True)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='homelab-retention-drill-'))
root.chmod(0o700)
password = root / 'password'
password.write_text(secrets.token_hex(32))
password.chmod(0o600)
source = root / 'source'
source.mkdir()
env = {**os.environ, 'RESTIC_REPOSITORY': str(root / 'repository'), 'RESTIC_PASSWORD_FILE': str(password)}


def restic(*argv):
    return subprocess.check_output([args.restic_binary, *argv], env=env, text=True, stderr=subprocess.PIPE)


def tool(*argv, ok=True):
    result = subprocess.run(['python3', str(Path(__file__).resolve().parents[1] / 'retention.py'), *argv,
                            '--restic-binary', args.restic_binary], env=env, text=True, capture_output=True)
    if (result.returncode == 0) != ok:
        raise AssertionError('Unexpected retention result: ' + result.stderr)
    return result


restic('init')
for index in range(3):
    (source / 'canary').write_text('isolated retention canary ' + str(index))
    restic('backup', '--tag', 'homelab-retention-drill', str(source))
snapshots = json.loads(restic('snapshots', '--json'))
snapshots.sort(key=lambda item: item['time'])
ids = [item['id'] for item in snapshots]
# Verify the protected recovery snapshot's bytes before marking it verified.
assert restic('dump', ids[-1], str(source / 'canary')) == 'isolated retention canary 2'
registry = root / 'register.json'
entries = [{'snapshot_id': sid, 'retain_until': '2000-01-01T00:00:00+00:00',
            'protected': index == 2, 'restore_verified': index == 2, 'retirement_approved': True}
           for index, sid in enumerate(ids)]
# First snapshot deliberately absent: unmanaged sets must survive.
registry.write_text(json.dumps({'schema_version': 1, 'snapshots': entries[1:]}))
plan = root / 'plan.json'
tool('plan', '--registry', str(registry), '--plan', str(plan))
value = json.loads(plan.read_text())
assert value['remove'] == [ids[1]] and ids[0] in value['keep'] and ids[2] in value['keep']
plan_hash = hashlib.sha256(plan.read_bytes()).hexdigest()
common = ['apply', '--registry', str(registry), '--plan', str(plan), '--approve-plan-sha256', plan_hash,
          '--repository-quiesced']
tool(*common, '--receipt', str(root / 'wrong-hash-receipt'), '--approve-plan-sha256', '0' * 64, ok=False)
# A changed operator register invalidates the approved plan before any deletion.
registry.write_text(registry.read_text() + '\n')
tool(*common, '--receipt', str(root / 'changed-register-receipt'), ok=False)
registry.write_text(json.dumps({'schema_version': 1, 'snapshots': entries[1:]}))
receipt = root / 'receipt.json'
tool(*common, '--receipt', str(receipt))
assert set(item['id'] for item in json.loads(restic('snapshots', '--json'))) == {ids[0], ids[2]}
assert restic('dump', ids[2], str(source / 'canary')) == 'isolated retention canary 2'
tool(*common, '--receipt', str(receipt), ok=False)
print(json.dumps({'status': 'PASS', 'original_snapshots': 3, 'retired': 1, 'retained': 2,
                  'unmanaged_and_verified_snapshot_preserved': True, 'changed_register_denied': True,
                  'wrong_approval_denied': True, 'retry_denied': True, 'data_pruned': False,
                  'evidence_root': str(root)}))
