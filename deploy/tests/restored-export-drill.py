"""NEW harmless durable export on an explicitly reconciled isolated restore.

Never changes restore gates, identity bindings or old jobs. The operator must
finish those separately before invoking this loopback-only fixture driver.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import secrets
import time
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--origin', required=True)
parser.add_argument('--credentials', required=True)
parser.add_argument('--binding-proof', required=True, help='Existing source fixture workspace/grant IDs')
parser.add_argument('--expected-project-root', required=True)
parser.add_argument('--evidence', required=True, help='New result file; no session tokens are recorded')
parser.add_argument('--resume', action='store_true', help='Validate the exact already accepted job; never resubmit')
args = parser.parse_args()
if urlsplit(args.origin).hostname not in ('127.0.0.1', 'localhost'):
    parser.error('Isolated loopback fixture only')
evidence = Path(args.evidence)
if evidence.exists() and not args.resume:
    raise ValueError('Evidence must be new; do not duplicate a previous job')
proof = json.loads(Path(args.binding_proof).read_text())
root = Path(args.expected_project_root).resolve(strict=True)
if not root.is_dir():
    raise ValueError('Explicit restored project root required')
cookie = ''
csrf = ''


def request(method, path, body=None, binary=False):
    global cookie, csrf
    headers = {'Origin': args.origin, 'Content-Type': 'application/json'}
    if cookie:
        headers['Cookie'] = cookie
    if csrf:
        headers['X-CSRF-Token'] = csrf
    data = None if body is None else json.dumps(body).encode()
    with urlopen(Request(args.origin + '/api/v1' + path, data=data, method=method, headers=headers), timeout=40) as response:
        if response.headers.get('Set-Cookie'):
            cookie = response.headers['Set-Cookie'].split(';')[0]
        if binary:
            result = response.read(128 * 1024 * 1024 + 1)
            if len(result) > 128 * 1024 * 1024:
                raise ValueError('Fixture export exceeds bounded download')
            return result
        result = json.load(response)
        if result.get('csrf_token'):
            csrf = result['csrf_token']
        return result


request('POST', '/auth/login', json.loads(Path(args.credentials).read_text()))
if args.resume:
    accepted = json.loads(evidence.read_text())
    assert accepted['status'] == 'accepted'
    job = {'id': accepted['job_id']}
else:
    preview = request('POST', '/projects/' + proof['workspace_id'] + '/exports/preview', {'grant_id': proof['grant_id']})
    job = request('POST', '/projects/' + proof['workspace_id'] + '/exports', {
        'grant_id': proof['grant_id'], 'idempotency_key': 'new-restored-export-' + secrets.token_hex(12),
        'expected_manifest_hash': preview['expected_manifest_hash'], 'acknowledged_exclusions': preview['exclusions']})
# Record the accepted unique job immediately. A failed run is evidence, not a
# reason to blindly repeat a physical request with another idempotency key.
evidence.write_text(json.dumps({'status': 'accepted', 'job_id': job['id']}, indent=2))
deadline = time.monotonic() + 150
while time.monotonic() < deadline:
    result = request('GET', '/jobs/' + job['id'])
    if result['state'] in ('completed', 'succeeded', 'failed', 'cancelled', 'interrupted'):
        break
    time.sleep(1)
else:
    raise TimeoutError('Preserve accepted export ID; do not automatically resubmit')
if result['state'] not in ('completed', 'succeeded'):
    evidence.write_text(json.dumps({'status': 'failed', 'job_id': job['id'], 'state': result['state']}, indent=2))
    raise AssertionError('Restored export did not succeed; inspect exact job')
artifact = next(item for item in result['artifacts'] if item['relative_path'] == 'project.zip')
data = request('GET', '/artifacts/' + artifact['id'] + '/download', binary=True)
assert hashlib.sha256(data).hexdigest() == artifact['sha256']
expected = {}
for path in root.rglob('*'):
    if path.is_symlink():
        raise ValueError('Unexpected link in isolated restored project')
    if path.is_file():
        expected[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    assert archive.testzip() is None
    names = [item.filename for item in archive.infolist() if not item.is_dir()]
    assert len(names) == len(set(names))
    assert set(names) == set(expected) | {'.homelab-export-manifest.json'}, 'Export must contain all fixture files, including hidden and large files'
    metadata = json.loads(archive.read('.homelab-export-manifest.json'))
    assert isinstance(metadata, dict)
    for name in expected:
        assert hashlib.sha256(archive.read(name)).hexdigest() == expected[name]
report = {'status': 'PASS', 'scope': 'new actual durable job after explicit isolated host reconciliation',
          'job_id': job['id'], 'artifact_id': artifact['id'], 'sha256': artifact['sha256'],
          'zip_integrity': 'PASS', 'all_restored_project_file_hashes': 'PASS', 'file_count': len(expected),
          'zip_bytes': len(data), 'workspace_id': proof['workspace_id']}
evidence.write_text(json.dumps(report, indent=2))
print(json.dumps(report))
