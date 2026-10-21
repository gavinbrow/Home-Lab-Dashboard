"""Create a new deployment's local secrets and persistent directories; never deploys."""
import argparse
import base64
import os
from pathlib import Path
import secrets
import json

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', required=True, help='New absolute directory, outside repository')
parser.add_argument('--hostname', default='dashboard.localhost')
parser.add_argument('--restore-drill', action='store_true')
args = parser.parse_args()
root = Path(args.root)
if not root.is_absolute() or root.exists():
    parser.error('--root must be an absolute, new directory')
if not args.hostname or not all(char.isalnum() or char in '.-' for char in args.hostname):
    parser.error('hostname must be a DNS name without a scheme or port')
root.mkdir(mode=0o700, parents=True)
for name in ('config', 'data', 'data/artifacts', 'data/caddy-data', 'data/caddy-config', 'data/backup-staging', 'backup-repository'):
    (root / name).mkdir(mode=0o700)
password = secrets.token_hex(32)
migration_password = secrets.token_hex(32)
admin_password = secrets.token_hex(32)
(root / 'config/app-password').write_text(password, encoding='ascii')
(root / 'config/migration-password').write_text(migration_password, encoding='ascii')
(root / 'config/postgres-admin-password').write_text(admin_password, encoding='ascii')
(root / 'config/database-admin-url').write_text('postgresql://postgres:'+admin_password+'@postgres:5432/homelab', encoding='ascii')
(root / 'config/migration.env').write_text('MIGRATION_DATABASE_URL=postgresql://homelab_migrator:'+migration_password+'@postgres:5432/homelab\nAPP_DB_ROLE=homelab_app\n', encoding='ascii')
(root / 'config/backup-repository-password').write_text(secrets.token_urlsafe(48), encoding='ascii')
(root / 'config/backup-destinations.json').write_text(json.dumps({'schema_version':1,'destinations':{'local':{
    'label':'Explicit local repository (separate-device status unverified)', 'repository':'/backup/repository',
    'password_file':'/run/secrets/backup_repository_password','staging_root':'/data/backup-staging',
    'key_root':'/backup/keys','ca_root':'/backup/ca','separate_device':False}}},indent=2), encoding='utf-8')
desktop_key = secrets.token_hex(16)
(root / 'config/guacamole-api-key').write_text(desktop_key, encoding='ascii')
(root / 'config/guacamole-gateway-key').write_text(desktop_key, encoding='ascii')
(root / 'config/runtime.env').write_text(
    'DATABASE_URL=postgresql://homelab_app:' + password + '@postgres:5432/homelab\n' +
    'MASTER_KEY=' + base64.b64encode(secrets.token_bytes(32)).decode() + '\n' +
    'BOOTSTRAP_TOKEN=' + secrets.token_urlsafe(48) + '\n', encoding='ascii')
for path in (root / 'config').iterdir():
    os.chmod(path, 0o600)
# Compose bind mounts use host paths. POSIX path spelling also works for Windows Docker Desktop.
(root / 'compose.env').write_text(
    'DATA_DIR=' + (root / 'data').as_posix() + '\n' +
    'CONFIG_DIR=' + (root / 'config').as_posix() + '\n' +
    'BACKUP_REPOSITORY_DIR=' + (root / 'backup-repository').as_posix() + '\n' +
    'DASHBOARD_HOST=' + args.hostname + '\nBIND_ADDRESS=127.0.0.1\nDISPATCH_ENABLED=false\nRESTORE_MODE=' +
    ('true' if args.restore_drill else 'false') + '\n', encoding='utf-8')
if args.restore_drill:
    (root / 'ISOLATED_RESTORE_DRILL').write_text('Created new isolated restore root; never attach production hosts.\n')
if os.name == 'posix':
    for name in ('data/artifacts','data/caddy-data','data/caddy-config','data/backup-staging','backup-repository'):
        os.chown(root / name, 10001, 10001)
    for name in ('runtime.env','migration.env','backup-destinations.json','backup-repository-password'):
        os.chmod(root / 'config' / name, 0o640)
        os.chown(root / 'config' / name, -1, 10001)
    os.chmod(root / 'config/guacamole-api-key', 0o640)
    os.chown(root / 'config/guacamole-api-key', -1, 10001)
    os.chmod(root / 'config/guacamole-gateway-key', 0o640)
    os.chown(root / 'config/guacamole-gateway-key', -1, 1001)
    # Local Compose file secrets retain host file ownership/mode when bind-mounted.
    # The pinned Debian PostgreSQL image's postgres account is UID/GID999.
    for name in ('postgres-admin-password',):
        os.chmod(root / 'config' / name, 0o640)
        os.chown(root / 'config' / name, -1, 999)
print('Created configuration at ' + str(root) + '. No services started. Protect config ACLs on Windows.')
