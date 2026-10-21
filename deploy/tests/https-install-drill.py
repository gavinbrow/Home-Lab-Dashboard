"""Fresh isolated production HTTPS bootstrap/login and replacement rehearsal."""
import argparse,json,os,secrets,socket,ssl
from pathlib import Path
from urllib.request import Request,urlopen,ProxyHandler,HTTPSHandler,build_opener
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',required=True)
args=parser.parse_args()
root=Path(args.root).resolve(strict=True)
if not root.name.startswith('homelab-https-'):parser.error('Explicit isolated HTTPS fixture required')
origin='https://dashboard.localhost:4449'
resolve=socket.getaddrinfo
socket.getaddrinfo=lambda host,port,*a,**kw:resolve('127.0.0.1' if host=='dashboard.localhost' else host,port,*a,**kw)
context=ssl.create_default_context(cafile=str(root/'data/caddy-data/caddy/pki/authorities/local/root.crt'))
opener=build_opener(ProxyHandler({}),HTTPSHandler(context=context))
cookie='';csrf='';secure=False
def request(method,path,body=None):
    global cookie,csrf,secure
    headers={'Origin':origin,'Content-Type':'application/json'}
    if cookie:headers['Cookie']=cookie
    if csrf:headers['X-CSRF-Token']=csrf
    with opener.open(Request(origin+path,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method),timeout=15) as response:
        data=json.load(response)
        if response.headers.get('Set-Cookie'):
            full=response.headers['Set-Cookie'];cookie=full.split(';')[0]
            secure=all(value in full.lower() for value in ('secure','httponly','samesite=strict'))
        if data.get('csrf_token'):csrf=data['csrf_token']
        return data
ready=request('GET','/readyz');assert ready['status']=='ready' and all(ready['checks'].values())
credentials=root/'owner-fixture.json'
if request('GET','/api/v1/auth/status')['bootstrap_required']:
    account={'email':'https-install@example.invalid','password':secrets.token_urlsafe(32)}
    with credentials.open('x') as target:json.dump(account,target)
    os.chmod(credentials,0o600)
    runtime=dict(line.split('=',1) for line in (root/'config/runtime.env').read_text().splitlines() if line)
    request('POST','/api/v1/auth/bootstrap',{**account,'token':runtime['BOOTSTRAP_TOKEN']})
    phase='fresh_bootstrap'
else:
    request('POST','/api/v1/auth/login',json.loads(credentials.read_text()));phase='retained_owner_login'
assert secure,'Production session cookie attributes missing'
assert request('GET','/api/v1/machines')['items']==[]
request('POST','/api/v1/auth/logout',{})
with opener.open(origin+'/',timeout=15) as response:
    html=response.read();assert b'<div id="root">' in html and b'/assets/' in html
report={'status':'PASS','phase':phase,'tls_certificate_validation':'PASS; explicit fixture CA, no system trust modification','readyz':ready['checks'],'secure_cookie':True,'csrf_logout':'PASS','static_app':'PASS','dispatch':'disabled by default'}
(root/(phase+'-evidence.json')).write_text(json.dumps(report,indent=2))
print(json.dumps(report))
