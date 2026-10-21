"""Verify the actual enrolled-host set without submitting another capture."""
import argparse,json,hashlib,uuid
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',required=True)
parser.add_argument('--backup-id',required=True)
parser.add_argument('--evidence',help='New distinct evidence path rather than replacing the current summary')
args=parser.parse_args()
root=Path(args.root).resolve(strict=True);bid=str(uuid.UUID(args.backup_id))
fixture=json.loads((root/'db-fixture.json').read_text())
sets=list((root/'data/backup-staging'/bid).glob('*/set/manifest.json'))
assert len(sets)==1
manifest=json.loads(sets[0].read_text());receipt=json.loads(sets[0].parent.with_suffix('.seal.json').read_text())
assert manifest['backup_set_id']==bid and manifest['status']=='STAGED' and manifest['gaps']==[]
assert receipt['backup_set_id']==bid and receipt['encrypted'] is True and receipt['repository_read_check']=='PASS'
host=next(item for item in manifest['components'] if item['kind']=='host-state' and item['machine_id']==fixture['machine_id'])
assert host['status']=='CAPTURED' and host['encrypted'] is True and host['consistency']=='quiesced'
assert host['covers_journal'] is True and fixture['workspace_id'] in host['workspace_ids']
assert host['coverage']['complete'] is True and host['coverage']['exclusions']==[]
bundle=sets[0].parent/host['file'];digest=hashlib.sha256()
with bundle.open('rb') as stream:
    for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
assert digest.hexdigest()==host['sha256']
report={'status':'PASS','backup_id':bid,'snapshot_id':receipt['snapshot_id'],'component_capture_coverage':'complete','separate_device':'UNVERIFIED; overall run remains incomplete','machine_id':fixture['machine_id'],'machine_generation':fixture['machine_generation'],'workspace_id':fixture['workspace_id'],'source_epoch':fixture['current_epoch'],'host_ciphertext_sha256':host['sha256'],'host_ciphertext_size':bundle.stat().st_size,'host_components':host['coverage']['components'],'private_key_transport':'ciphertext only; private age identity escrowed separately','repository_read_check':'PASS','restore':'NOT RUN'}
target=Path(args.evidence) if args.evidence else root/'enrolled-capture-evidence.json'
with target.open('x' if args.evidence else 'w') as stream:json.dump(report,stream,indent=2)
print(json.dumps({key:report[key] for key in ('status','backup_id','snapshot_id','component_capture_coverage','host_ciphertext_sha256','host_ciphertext_size','separate_device')}))
