"""Restore an exact sealed set to new staging and install into a new fenced drill root."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from backup import sha, verify
from restore import extract


def empty_copy(source, target):
    source, target = Path(source), Path(target)
    if target.exists() and (target.is_symlink() or any(target.iterdir())):
        raise ValueError('Install destination must be empty: ' + str(target))
    target.mkdir(parents=True, mode=0o700, exist_ok=True)
    for path in source.rglob('*'):
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise ValueError('Links are unsupported in recovered bytes')
        relative = path.relative_to(source)
        destination = target / relative
        if path.is_dir():
            destination.mkdir(mode=0o700, exist_ok=True)
        elif path.is_file():
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        else:
            raise ValueError('Special recovered files are unsupported')


def runtime_values(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        key, value = line.split('=', 1)
        if key not in ('DATABASE_URL', 'MASTER_KEY', 'BOOTSTRAP_TOKEN') or key in result:
            raise ValueError('Unexpected runtime key')
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', required=True)
    parser.add_argument('--output', required=True, help='New protected directory for decrypted bytes')
    parser.add_argument('--install-root', help='New configure.py --restore-drill root; never production')
    parser.add_argument('--restic-binary', default=os.environ.get('RESTIC_BINARY', 'restic'))
    parser.add_argument('--host-agent-binary', help='Explicit reviewed agent CLI for offline age bundle verification')
    parser.add_argument('--host-agent-sha256', help='Expected executable hash; required with --host-agent-binary')
    parser.add_argument('--host-identity-file', help='Separately escrowed private age identity; never sent over RPC')
    args = parser.parse_args()
    if args.host_agent_binary:
        if not args.host_identity_file or not args.host_agent_sha256 or sha(args.host_agent_binary)!=args.host_agent_sha256:
            raise ValueError('Reviewed agent hash and separate age identity are required for host unseal')
    elif args.host_identity_file or args.host_agent_sha256:
        raise ValueError('Host unseal requires an explicit reviewed agent executable')
    if not os.environ.get('RESTIC_REPOSITORY') or not os.environ.get('RESTIC_PASSWORD_FILE'):
        raise ValueError('Protected restic repository and password file are required')
    version = subprocess.check_output([args.restic_binary, 'version'], text=True)
    if not version.startswith('restic 0.18.1 '):
        raise ValueError('Reviewed restic0.18.1 required')
    receipt = json.loads(Path(args.receipt).read_text())
    if not receipt.get('encrypted') or receipt.get('repository_read_check') != 'PASS':
        raise ValueError('A verified encrypted-set receipt is required')
    output = Path(args.output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    decrypted = output / 'decrypted'
    subprocess.run([args.restic_binary, 'check', '--read-data'], capture_output=True, check=True)
    subprocess.run([args.restic_binary, 'restore', receipt['snapshot_id'], '--target', str(decrypted)], capture_output=True, check=True)
    matches = [path for path in decrypted.rglob('manifest.json') if sha(path) == receipt['manifest_sha256']]
    if len(matches) != 1:
        raise ValueError('Exact sealed manifest was not recovered uniquely')
    staged = matches[0].parent
    manifest = verify(staged)
    if manifest['backup_set_id'] != receipt['backup_set_id']:
        raise ValueError('Restored set identity mismatch')
    extracted = output / 'extracted'
    extracted.mkdir(mode=0o700)
    components = {}
    for component in manifest['components']:
        if component['status'] != 'CAPTURED':
            continue
        name, cid = component['file'], component['id']
        source = staged / name
        target = extracted / cid
        if name.endswith('.tar.gz'):
            extract(source, target)
        else:
            target.mkdir(mode=0o700)
            shutil.copy2(source, target / name)
        components[cid] = {'kind': component['kind'], 'path': str(target), 'sha256': component['sha256'],
                           'machine_id': component.get('machine_id'), 'workspace_id': component.get('workspace_id')}
        if component['kind']=='host-state':
            components[cid]['host_unseal']='NOT RUN; separate age identity required'
            if args.host_agent_binary:
                result=subprocess.run([args.host_agent_binary,'backup-unseal','--bundle',str(target/name),
                    '--identity-file',args.host_identity_file,'--output',str(target/'unsealed'),
                    '--sha256',component['sha256']],capture_output=True,text=True)
                if result.returncode!=0:
                    raise ValueError('Offline host bundle verification failed')
                proof=json.loads(result.stdout)
                if proof.get('verified') is not True or proof.get('ciphertext_sha256')!=component['sha256']:
                    raise ValueError('Offline host bundle did not report verified ciphertext identity')
                components[cid]['host_unseal']='PASS'
                components[cid]['host_agent_sha256']=args.host_agent_sha256
    report = {'backup_set_id': manifest['backup_set_id'], 'snapshot_id': receipt['snapshot_id'],
              'coverage': manifest['status'], 'integrity': 'PASS', 'dispatch_enabled': False,
              'restore_mode': True, 'database_restore': 'NOT RUN', 'key_recovery': 'NOT INSTALLED',
              'host_reconciliation': 'NOT RUN', 'components': components, 'gaps': manifest['gaps']}
    if args.install_root:
        root = Path(args.install_root).resolve(strict=True)
        if not (root / 'ISOLATED_RESTORE_DRILL').is_file():
            raise ValueError('Install requires a new isolated restore-drill root')
        env = dict(line.split('=', 1) for line in (root / 'compose.env').read_text().splitlines() if line and not line.startswith('#'))
        if env.get('RESTORE_MODE') != 'true' or Path(env['DATA_DIR']).resolve() != root / 'data':
            raise ValueError('Drill root mapping has changed')
        for kind in ('artifacts', 'keys', 'ca', 'postgres'):
            found = [item for item in components.values() if item['kind'] == kind]
            if len(found) != 1:
                raise ValueError('Exactly one captured control-plane component required: ' + kind)
        artifacts = next(item for item in components.values() if item['kind'] == 'artifacts')
        empty_copy(artifacts['path'], root / 'data/artifacts')
        ca = next(item for item in components.values() if item['kind'] == 'ca')
        empty_copy(ca['path'], root / 'data/caddy-data')
        keys = Path(next(item for item in components.values() if item['kind'] == 'keys')['path'])
        original = runtime_values(keys / 'runtime.env')
        key = base64.b64decode(original['MASTER_KEY'], validate=True)
        if len(key) != 32:
            raise ValueError('Recovered master key invalid')
        target_runtime = root / 'config/runtime.env'
        fresh = runtime_values(target_runtime)
        fresh['MASTER_KEY'] = original['MASTER_KEY']
        fresh.pop('BOOTSTRAP_TOKEN', None)
        # Preserve fresh database URL/password; never resurrect the old database endpoint.
        target_runtime.write_text(''.join(k + '=' + v + '\n' for k, v in fresh.items()))
        os.chmod(target_runtime, 0o600 if os.name == 'nt' else 0o640)
        for name in ('dispatch-private.pem', 'dispatch-public.pem', 'dispatch-key-id', 'agent-ca-key.pem', 'agent-ca-cert.pem',
                     'agent-server-key.pem', 'agent-server-cert.pem', 'guacamole-api-key', 'guacamole-gateway-key'):
            source = keys / name
            if source.exists():
                # A new trust identity must not be used against old hosts until reconciliation.
                destination = root / 'config' / name
                if destination.exists() and name not in ('guacamole-api-key', 'guacamole-gateway-key'):
                    raise ValueError('Refusing to replace an existing trust key')
                shutil.copyfile(source, destination)
                os.chmod(destination, 0o640 if os.name == 'posix' else 0o600)
                if os.name == 'posix':
                    os.chown(destination, -1, 1001 if name == 'guacamole-gateway-key' else 10001)
        # Both upstream JSON auth and API auth use the same restored secret.
        guac=root/'config/guacamole-api-key'
        if guac.exists():
            gateway=root/'config/guacamole-gateway-key'
            shutil.copyfile(guac,gateway)
            os.chmod(gateway,0o640 if os.name=='posix' else 0o600)
            if os.name=='posix':os.chown(gateway,-1,1001)
        recovered = root / 'recovered-hosts'
        recovered.mkdir(mode=0o700, exist_ok=False)
        remap = []
        for cid, item in components.items():
            if item['kind'] in ('project', 'sqlite', 'host-state', 'host-export'):
                empty_copy(item['path'], recovered / cid)
                remap.append({'component_id': cid, 'machine_id': item['machine_id'],
                              'workspace_id': item['workspace_id'], 'recovered_path': str(recovered / cid),
                              'target_machine_id': None, 'target_root': None, 'reconciliation': 'REQUIRED'})
        (root / 'identity-remap-plan.json').write_text(json.dumps(remap, indent=2))
        report['key_recovery'] = 'INSTALLED; CRYPTOGRAPHIC USE NOT YET VERIFIED'
        report['master_key_sha256'] = hashlib.sha256(key).hexdigest()
        report['install_root'] = str(root)
        if os.name == 'posix':
            for path in [root / 'data/artifacts'] + list((root / 'data/artifacts').rglob('*')):
                os.chown(path, 10001, 10001)
            os.chown(target_runtime, -1, 10001)
    (output / 'restore-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps({key: report[key] for key in ('backup_set_id', 'coverage', 'integrity', 'key_recovery', 'database_restore', 'host_reconciliation')}))
    return 0 if manifest['status'] == 'STAGED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
