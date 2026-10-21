"""Real restic/file/SQLite recovery fixture; never substitutes for enrolled-host acceptance."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-root', required=True)
parser.add_argument('--output-root', required=True)
parser.add_argument('--restic-binary', required=True)
args = parser.parse_args()
source = Path(args.source_root).resolve(strict=True)
output = Path(args.output_root).resolve()
output.mkdir(mode=0o700, parents=True, exist_ok=False)
repo = Path(__file__).resolve().parents[2]
fixture = json.loads((source / 'fixture/fixture.json').read_text())
ids = fixture['ids']
with closing(sqlite3.connect(source / 'fixture/ledger.sqlite')) as db:
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE operations(id TEXT PRIMARY KEY, state TEXT)')
    db.execute('INSERT INTO operations VALUES(?,?)', (ids['operation'], 'succeeded'))
    db.commit()
inventory = {'database_inventory_file': str(source / 'capture-cut1/database-inventory.json'),
 'database_inventory_evidence': 'actual pinned PostgreSQL17.11 custom-format dump with API/worker stopped',
 'quiescence_evidence': 'synthetic fixture has no external writers; immutable output and closed journal',
 'key_recovery_evidence': 'protected random master/dispatch/privateCA keys present; cryptographic use checked after recovery',
 'software_version_evidence': 'Docker29.7.2 Node24.22.0 PG17.11 restic0.18.1; source repository and image pins',
 'components': []}
for cid,kind,path in [('database','postgres','capture-cut1/database.dump'),('artifacts','artifacts','data/artifacts'),
                      ('keys','keys','config'),('caddy_ca','ca','data/caddy-data'),
                      ('project','project','fixture/project'),('journal','sqlite','fixture/ledger.sqlite'),
                      ('host_state','host-state','fixture/host-state')]:
    item={'id':cid,'kind':kind,'source':str(source/path),'required':True,'consistent':True,
          'consistency':'quiesced-fixture','capture_evidence':'isolated deterministic fixture; no external host claims'}
    if kind=='project':item['workspace_id']=ids['workspace']
    if kind in ('sqlite','host-state'):item['machine_id']=ids['machine']
    inventory['components'].append(item)
inventory_path=output/'inventory.json';inventory_path.write_text(json.dumps(inventory,indent=2))


def run(script,*parameters,env=None):
    subprocess.run([sys.executable,str(repo/'deploy'/script),*parameters],env=env,check=True)


staged=output/'complete-set'
run('backup.py','stage','--inventory',str(inventory_path),'--output',str(staged))
password_file=output/'restic-password';password_file.write_text(secrets.token_urlsafe(48));os.chmod(password_file,0o600)
env=os.environ.copy();env.update(RESTIC_REPOSITORY=str(output/'encrypted-repository'),RESTIC_PASSWORD_FILE=str(password_file),RESTIC_BINARY=args.restic_binary)
subprocess.run([args.restic_binary,'init'],env=env,check=True,capture_output=True)
run('backup.py','seal',str(staged),'--restic-binary',args.restic_binary,env=env)
install=output/'restored-control'
run('configure.py','--root',str(install),'--restore-drill','--hostname','restore.localhost')
run('recover-set.py','--receipt',str(staged)+'.seal.json','--output',str(output/'recovered'),'--install-root',str(install),'--restic-binary',args.restic_binary,env=env)
original=(source/'config/runtime.env').read_text();restored=(install/'config/runtime.env').read_text()
old_key=next(line for line in original.splitlines() if line.startswith('MASTER_KEY='))
assert old_key in restored
assert 'BOOTSTRAP_TOKEN=' not in restored
assert (source/'config/runtime.env').read_text().splitlines()[0] != restored.splitlines()[0], 'Fresh target database credentials must survive'
binary=install/'recovered-hosts/project/output.bin'
assert hashlib.sha256(binary.read_bytes()).hexdigest()==fixture['artifact_hash']
assert (install/'recovered-hosts/project/.instructions').read_text()=='retain me'
with closing(sqlite3.connect(install/'recovered-hosts/journal/journal.sqlite')) as db:
    assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert db.execute('SELECT id,state FROM operations').fetchall()==[(ids['operation'],'succeeded')]
# An unreachable required component never silently inherits the preceding complete status.
inventory['components'][4]['source']=str(output/'offline-project')
partial_inventory=output/'incomplete-inventory.json';partial_inventory.write_text(json.dumps(inventory))
partial=subprocess.run([sys.executable,str(repo/'deploy/backup.py'),'stage','--inventory',str(partial_inventory),'--output',str(output/'incomplete-set')],capture_output=True,text=True)
assert partial.returncode==2
report={'encrypted_restic_roundtrip':'PASS','repository_read_check':'PASS','master_key_preserved':'PASS',
 'fresh_database_credentials_preserved':'PASS','project_binary_dotfiles':'PASS','sqlite_snapshot_integrity':'PASS',
 'offline_required_project_exit_code':partial.returncode,'dispatch_enabled':False,'restore_mode':True,
 'database_restore':'NEXT STEP; not performed by this file/crypto fixture','host_reconciliation':'NOT RUN',
 'separate_device':'NOT VERIFIED; same-device disposable repository fixture',
 'live_machine_acceptance':'NOT CLAIMED','install_root':str(install)}
(output/'component-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
