"""Issue one enrolled host fixture token without printing it; loopback tests only."""
import argparse,json,os,subprocess,uuid
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.parse import urlsplit
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',required=True)
parser.add_argument('--origin',required=True)
parser.add_argument('--os',choices=['windows','linux'],required=True)
parser.add_argument('--refresh',action='store_true')
args=parser.parse_args()
root=Path(args.root).resolve(strict=True)
if not root.name.startswith('homelab-backup-') or urlsplit(args.origin).hostname!='127.0.0.1':parser.error('Explicit disposable backup fixture required')
account=json.loads((root/'backup-fixture-owner.json').read_text())
cookie='';csrf=''
def request(path,body):
    global cookie,csrf
    headers={'Origin':args.origin,'Content-Type':'application/json'}
    if cookie:headers['Cookie']=cookie
    if csrf:headers['X-CSRF-Token']=csrf
    with urlopen(Request(args.origin+'/api/v1'+path,data=json.dumps(body).encode(),headers=headers,method='POST'),timeout=15) as response:
        result=json.load(response)
        if response.headers.get('Set-Cookie'):cookie=response.headers['Set-Cookie'].split(';')[0]
        if result.get('csrf_token'):csrf=result['csrf_token']
        return result
request('/auth/login',account)
path=root/'host-enrollment.json'
if args.refresh:
    machine={'id':str(uuid.UUID(json.loads(path.read_text())['machine_id']))}
    # Fixture metadata correction is allowed only before any certificate exists.
    changed=subprocess.check_output(['docker','exec',root.name+'-postgres-1','psql','-U','postgres','-d','homelab','-At','-c',
        "UPDATE machines SET os='"+args.os+"' WHERE id='"+machine['id']+"' AND NOT EXISTS(SELECT 1 FROM agent_certificates WHERE machine_id='"+machine['id']+"') RETURNING id"],text=True)
    if machine['id'] not in changed:raise ValueError('Refuse to change an enrolled fixture installation')
else:machine=request('/machines',{'name':'Explicit full backup host fixture','os':args.os})
enrollment=request('/machines/'+machine['id']+'/enrollments',{})
epoch=subprocess.check_output(['docker','exec',root.name+'-postgres-1','psql','-U','postgres','-d','homelab','-At','-c','SELECT dispatch_epoch FROM runtime_control WHERE singleton'],text=True).strip()
with path.open('w' if args.refresh else 'x') as target:json.dump({'machine_id':machine['id'],'dispatch_epoch':epoch,'token':enrollment['token'],'tls_endpoint':'https://127.0.0.1:3451','config_root':str(root/'config')},target)
os.chmod(path,0o600)
if os.name=='posix':os.chown(path,1000,1000);os.chown(root,1000,1000)
print('Created protected fixture enrollment at '+str(path)+'; token not logged.')
