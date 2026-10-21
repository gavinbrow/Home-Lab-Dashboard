"""Prepare new role/destination files without changing existing runtime credentials.

Run provision and migration successfully before the explicit --activate step.
Existing secrets, PostgreSQL data and master keys are preserved.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit, urlunsplit, quote

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',required=True)
parser.add_argument('--activate',action='store_true')
args=parser.parse_args()
root=Path(args.root).resolve(strict=True)
config=root/'config'
runtime=config/'runtime.env'
values=dict(line.split('=',1) for line in runtime.read_text().splitlines() if line and not line.startswith('#'))
url=urlsplit(values['DATABASE_URL'])
if url.scheme not in ('postgres','postgresql') or not url.hostname or url.path!='/homelab':
    parser.error('Expected configured PostgreSQL homelab database')
authority=url.hostname+(':'+str(url.port) if url.port else '')
def database_url(user,password):
    return urlunsplit((url.scheme,quote(user,safe='')+':'+quote(password,safe='')+'@'+authority,url.path,url.query,''))
def publish(name,content):
    path=config/name
    if not path.exists():
        with path.open('x',encoding='utf-8') as target: target.write(content)
        protected=name in ('database-admin-url','app-password','migration-password')
        os.chmod(path,0o600 if protected else 0o640)
        if os.name=='posix' and not protected: os.chown(path,-1,10001)
    return path.read_text().strip()
app=publish('app-password',secrets.token_hex(32))
migrator=publish('migration-password',secrets.token_hex(32))
admin=(config/'postgres-admin-password').read_text().strip()
publish('database-admin-url',database_url('postgres',admin))
publish('migration.env','MIGRATION_DATABASE_URL='+database_url('homelab_migrator',migrator)+'\nAPP_DB_ROLE=homelab_app\n')
publish('backup-repository-password',secrets.token_urlsafe(48))
publish('backup-destinations.json',json.dumps({'schema_version':1,'destinations':{'local':{
    'label':'Local repository (separate device unverified)','repository':'/backup/repository',
    'password_file':'/run/secrets/backup_repository_password','staging_root':'/data/backup-staging',
    'key_root':'/backup/keys','ca_root':'/backup/ca','separate_device':False}}},indent=2))
for path in (root/'data/backup-staging',root/'backup-repository'):
    path.mkdir(mode=0o700,exist_ok=True)
    if os.name=='posix':os.chown(path,10001,10001)
env=root/'compose.env'
if not any(line.startswith('BACKUP_REPOSITORY_DIR=') for line in env.read_text().splitlines()):
    with env.open('a',encoding='utf-8') as target:target.write('\nBACKUP_REPOSITORY_DIR='+(root/'backup-repository').as_posix()+'\n')
if args.activate:
    # Operator runs this only after scoped provision and migrations have passed.
    values['DATABASE_URL']=database_url('homelab_app',app)
    pending=config/('runtime.env.pending-'+secrets.token_hex(8))
    with pending.open('x',encoding='utf-8') as target:target.write(''.join(key+'='+value+'\n' for key,value in values.items()))
    os.chmod(pending,0o640)
    if os.name=='posix':os.chown(pending,-1,10001)
    pending.replace(runtime)
    print('Activated application DML credentials. Existing master key and data preserved.')
else:
    print('Prepared protected role/destination files. Runtime credentials unchanged; run provision, migration, then explicit --activate.')
