"""One-time Ed25519 dispatch identity and private agent TLS CA/server provisioning."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root', required=True)
parser.add_argument('--agent-hostname', required=True)
parser.add_argument('--agent-ip', action='append', default=[])
parser.add_argument('--openssl-binary', default=shutil.which('openssl'))
args = parser.parse_args()
if not args.openssl_binary:
    parser.error('An existing supported OpenSSL executable is required; no installer is run')
if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?', args.agent_hostname):
    parser.error('Invalid agent DNS hostname')
addresses = [str(ipaddress.ip_address(item)) for item in args.agent_ip]
root = Path(args.root).resolve(strict=True)
config = root / 'config'
names = ('dispatch-private.pem', 'dispatch-public.pem', 'agent-ca-key.pem', 'agent-ca-cert.pem',
         'agent-server-key.pem', 'agent-server-cert.pem', 'dispatch-key-id')
if any((config / name).exists() for name in names):
    parser.error('Trust provisioning refuses any existing key; rotation must be explicit')
work = config / ('.trust-generation-' + uuid.uuid4().hex)
work.mkdir(mode=0o700)


def openssl(*parameters):
    subprocess.run([args.openssl_binary, *parameters], cwd=work, check=True, capture_output=True)


openssl('genpkey', '-algorithm', 'ED25519', '-out', 'dispatch-private.pem')
openssl('pkey', '-in', 'dispatch-private.pem', '-pubout', '-out', 'dispatch-public.pem')
openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'agent-ca-key.pem')
openssl('req', '-new', '-x509', '-sha256', '-days', '3650', '-key', 'agent-ca-key.pem',
        '-subj', '/CN=Homelab Private Agent CA', '-out', 'agent-ca-cert.pem',
        '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'agent-server-key.pem')
openssl('req', '-new', '-sha256', '-key', 'agent-server-key.pem', '-subj', '/CN=' + args.agent_hostname,
        '-out', 'server.csr')
san = 'DNS:' + args.agent_hostname + ''.join(',IP:' + address for address in addresses)
(work / 'server.ext').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' + san + '\n')
openssl('x509', '-req', '-in', 'server.csr', '-CA', 'agent-ca-cert.pem', '-CAkey', 'agent-ca-key.pem',
        '-set_serial', str(uuid.uuid4().int), '-days', '397', '-sha256', '-extfile', 'server.ext', '-out', 'agent-server-cert.pem')
openssl('verify', '-CAfile', 'agent-ca-cert.pem', 'agent-server-cert.pem')
key_id = 'dispatch-' + uuid.uuid4().hex
(work / 'dispatch-key-id').write_text(key_id)
for name in names:
    destination = config / name
    # Hard-link publication never overwrites an existing key after a concurrent provisioning.
    os.link(work / name, destination)
    os.chmod(destination, 0o640 if os.name == 'posix' else 0o600)
    if os.name == 'posix':
        os.chown(destination, -1, 10001)
print(json.dumps({'status': 'PROVISIONED', 'dispatch_key_id': key_id,
                  'agent_hostname': args.agent_hostname, 'agent_ips': addresses,
                  'server_certificate_days': 397, 'ca_days': 3650,
                  'rotation': 'explicit only; existing keys are never replaced'}))
