"""Reset only the explicit disposable backup fixture account, without argv secrets."""
import argparse,json,os,secrets,subprocess
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',required=True)
parser.add_argument('--container',required=True)
args=parser.parse_args()
root=Path(args.root).resolve(strict=True)
if not root.name.startswith('homelab-backup-') or not args.container.startswith(root.name+'-api-'):
    parser.error('Only the owned disposable backup fixture is permitted')
account={'email':'backup-fixture@example.invalid','password':secrets.token_urlsafe(32)}
path=root/'backup-fixture-owner.json'
with path.open('x') as target:json.dump(account,target)
os.chmod(path,0o600)
subprocess.run(['docker','exec','-i',args.container,'/bin/sh','-c',
    'IFS= read -r RECOVERY_PASSWORD; export RECOVERY_PASSWORD; export RECOVERY_EMAIL=backup-fixture@example.invalid; cd /app; exec /app/deploy/entrypoint.sh npm run auth:recover'],
    input=account['password']+'\n',text=True,check=True)
