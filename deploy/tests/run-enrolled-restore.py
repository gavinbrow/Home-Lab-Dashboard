"""Offline restore of one exact enrolled-host fixture set; never starts a service."""
import argparse,json,hashlib,os,subprocess,uuid
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',required=True)
parser.add_argument('--backup-id',required=True)
parser.add_argument('--output',required=True)
parser.add_argument('--install-root')
parser.add_argument('--agent-binary',default='/mnt/c/Projects/Home-Lab-Dashboard/agent/bin/homelab-agent-linux-wave3-prerequisite-8')
parser.add_argument('--agent-sha256',default='97668cceb608e122714a8ee0be3b4da0b810d4f7507b94fd8166090f9913a29d')
args=parser.parse_args()
root=Path(args.root).resolve(strict=True);bid=str(uuid.UUID(args.backup_id))
host=json.loads((root/'host-fixture.json').read_text())
receipts=list((root/'data/backup-staging'/bid).glob('*/set.seal.json'))
if len(receipts)!=1:raise ValueError('One exact snapshot receipt required')
agent=args.agent_binary
agent_sha=args.agent_sha256
env={**os.environ,'RESTIC_REPOSITORY':str(root/'backup-repository'),'RESTIC_PASSWORD_FILE':str(root/'config/backup-repository-password'),'RESTIC_BINARY':'/tmp/homelab-restic-linux-wave2/restic'}
command=['python3',str(Path(__file__).parents[1]/'recover-set.py'),'--receipt',str(receipts[0]),'--output',args.output,
    '--host-agent-binary',agent,'--host-agent-sha256',agent_sha,'--host-identity-file',host['age_identity_file']]
if args.install_root:command+=['--install-root',args.install_root]
subprocess.run(command,env=env,check=True)
