"""Explicit disposable fixture: HTTP submission -> durable worker -> encrypted history.

Requires a NEW empty configured fixture and a running worker. No live inventory.
"""
import argparse
import json
from pathlib import Path
import secrets
import time
import os
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from urllib.parse import urlsplit

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',required=True)
parser.add_argument('--origin',required=True)
parser.add_argument('--cancel',action='store_true',help='Cancel this exact disposable capture while its phase is active')
parser.add_argument('--require-host-capture',action='store_true')
parser.add_argument('--evidence',help='New proof file for this distinct attempt; preserve earlier runs')
args=parser.parse_args()
if urlsplit(args.origin).hostname not in ('127.0.0.1','localhost'):
    parser.error('Disposable loopback fixture only')
root=Path(args.root).resolve(strict=True)
if args.evidence and Path(args.evidence).exists():
    raise ValueError('Evidence must be new; inspect the earlier job instead of resubmitting')
runtime=dict(line.split('=',1) for line in (root/'config/runtime.env').read_text().splitlines() if line)
cookie='';csrf=''
def request(method,path,body=None):
    global cookie,csrf
    headers={'Origin':args.origin,'Content-Type':'application/json'}
    if cookie:headers['Cookie']=cookie
    if csrf:headers['X-CSRF-Token']=csrf
    req=Request(args.origin+'/api/v1'+path, data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
    try:
        with urlopen(req,timeout=15) as response:
            data=json.load(response)
            if response.headers.get('Set-Cookie'):cookie=response.headers['Set-Cookie'].split(';')[0]
            if data.get('csrf_token'):csrf=data['csrf_token']
            return data
    except HTTPError as error:
        raise RuntimeError('Fixture HTTP failure '+str(error.code)+' '+path) from None
status=request('GET','/auth/status')
credentials=root/'backup-fixture-owner.json'
if status['bootstrap_required']:
    account={'email':'backup-fixture@example.invalid','password':secrets.token_urlsafe(32)}
    with credentials.open('x') as target:json.dump(account,target)
    os.chmod(credentials,0o600)
    request('POST','/auth/bootstrap',{**account,'token':runtime['BOOTSTRAP_TOKEN']})
else:
    account=json.loads(credentials.read_text())
    request('POST','/auth/login',account)
destination=request('POST','/backup-destinations',{'name':'Explicit disposable local repo','repository_ref':'local','enabled':True})
readiness=request('GET','/backups/readiness')
assert readiness['available'] is True,readiness['reasons']
job=request('POST','/backups',{'destination_id':destination['id'],'idempotency_key':'actual-api-backup-'+secrets.token_hex(8)})
if args.evidence:
    with Path(args.evidence).open('x') as target:
        json.dump({'status':'accepted','job_id':job['id'],'backup_id':job['backup_id']},target,indent=2)
deadline=time.monotonic()+120
cancelled=False
while time.monotonic()<deadline:
    rows=request('GET','/backups')['items']
    run=next((row for row in rows if row['id']==job['backup_id']),None)
    if args.cancel and not cancelled and run and run['manifest']['phase']=='capturing':
        request('POST','/jobs/'+job['id']+'/cancel',{});cancelled=True
    if run and run['status'] in ('complete','incomplete','failed'):break
    if run and run['status']=='cancelled':break
    time.sleep(.1 if args.cancel else 1)
else:raise TimeoutError('Durable backup fixture timed out')
if args.cancel:
    assert cancelled and run['status']=='cancelled',run
    assert request('GET','/jobs/'+job['id'])['state']=='cancelled'
    assert 'maintenance_active' not in request('GET','/backups/readiness')['reasons']
    report={'status':'PASS','backup_id':run['id'],'cancel_requested_during':'capturing','history':'cancelled','job':'cancelled','maintenance_released':True,'scope':'exact disposable fixture; no host command launch'}
    target=Path(args.evidence) if args.evidence else root/'api-backup-cancel-evidence.json'
    target.write_text(json.dumps(report,indent=2))
    print(json.dumps(report));raise SystemExit(0)
assert run['status']=='incomplete',run
assert run['manifest']['encrypted'] is True,run
assert run['manifest']['repository_read_check']=='PASS',run
assert {'separate_device_destination_unverified'} <= {gap['code'] for gap in run['manifest']['gaps']},run
assert request('GET','/backups/readiness')['last_complete'] is None
hosts=[item for item in run['manifest']['components'] if item['kind']=='host-state']
if args.require_host_capture:
    expected=json.loads((root/'db-fixture.json').read_text())
    assert any(item.get('machine_id')==expected['machine_id'] for item in hosts)
    assert run['manifest']['gaps']==[{'code':'separate_device_destination_unverified'}],run
report={'status':'PASS','scope':'actual enrolled host capture' if hosts else 'new empty owner fixture; no enrolled hosts','backup_id':run['id'],'coverage':run['status'],'encrypted':True,'repository_read_check':'PASS','gaps':run['manifest']['gaps'],'host_components':hosts,'last_complete_preserved':True}
target=Path(args.evidence) if args.evidence else root/'api-backup-evidence.json'
target.write_text(json.dumps(report,indent=2))
print(json.dumps(report))
