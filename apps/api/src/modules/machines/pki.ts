import 'reflect-metadata';
import { createPrivateKey, randomBytes, webcrypto, X509Certificate as NativeCertificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
const cryptoApi = webcrypto.subtle;
export interface IssuedCertificate { certificate_pem: string; ca_pem: string; serial: string; expires_at: string; fingerprint: string; public_key_fingerprint: string }
export interface CertificateAuthority { ca_pem: string; issue(csr: string, machine: string): Promise<IssuedCertificate> }
const serial = () => '01' + randomBytes(19).toString('hex');
export async function loadAuthority(ca_pem: string, key_pem: string): Promise<CertificateAuthority> {
  const native = new NativeCertificate(ca_pem);
  const privateKey = createPrivateKey(key_pem);
  if (!native.ca || !native.checkPrivateKey(privateKey) || Date.parse(native.validTo) <= Date.now() || Date.parse(native.validFrom) > Date.now()) throw new Error('Agent CA certificate/key is invalid or expired');
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Agent CA requires ECDSA P-256');
  const ca = new x509.X509Certificate(ca_pem);
  const usage = ca.getExtension(x509.KeyUsagesExtension);
  if (usage && !(usage.usages & x509.KeyUsageFlags.keyCertSign)) throw new Error('Agent CA lacks certificate-signing usage');
  const signingKey = await cryptoApi.importKey('pkcs8', privateKey.export({ format: 'der', type: 'pkcs8' }), algorithm, false, ['sign']);
  return { ca_pem, async issue(csr_pem, machine) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machine) || csr_pem.length > 16384) throw new Error('Invalid machine identity or CSR size');
    if (ca.notAfter.getTime() <= Date.now()) throw new Error('Agent CA is expired');
    const csr = new x509.Pkcs10CertificateRequest(csr_pem);
    const csrAlgorithm = csr.signatureAlgorithm as EcdsaParams;
    if (csrAlgorithm.name !== 'ECDSA' || (typeof csrAlgorithm.hash === 'string' ? csrAlgorithm.hash : csrAlgorithm.hash.name) !== 'SHA-256') throw new Error('Agent CSR signatures require ECDSA SHA-256');
    if (!await csr.verify()) throw new Error('CSR proof of possession is invalid');
    const publicKey = await csr.publicKey.export();
    const keyAlgorithm = publicKey.algorithm as EcKeyAlgorithm;
    if (keyAlgorithm.name !== 'ECDSA' || keyAlgorithm.namedCurve !== 'P-256') throw new Error('Agent CSR requires ECDSA P-256');
    const expires = new Date(Math.min(Date.now() + 30 * 86400000, ca.notAfter.getTime()));
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(), subject: `CN=${machine}`, issuer: ca.subjectName,
      notBefore: new Date(Date.now() - 60000), notAfter: expires, publicKey,
      signingKey, signingAlgorithm: algorithm,
      // Deliberately ignore all requested CSR subject/extension privileges.
      extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2'], true), new x509.SubjectAlternativeNameExtension([{ type: 'url', value: `urn:homelab:machine:${machine}` }])],
    });
    const certificate_pem = cert.toString('pem');
    const parsed = new NativeCertificate(certificate_pem);
    return { certificate_pem, ca_pem, serial: parsed.serialNumber, expires_at: new Date(parsed.validTo).toISOString(), fingerprint: parsed.fingerprint256, public_key_fingerprint: await fingerprintPublicKey(parsed) };
  } };
}

async function fingerprintPublicKey(cert: NativeCertificate): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

export async function authorityFromEnvironment(): Promise<CertificateAuthority | null> {
  if (!process.env.AGENT_CA_CERT_FILE || !process.env.AGENT_CA_KEY_FILE) return null;
  return loadAuthority(await readFile(process.env.AGENT_CA_CERT_FILE, 'utf8'), await readFile(process.env.AGENT_CA_KEY_FILE, 'utf8'));
}

/** Explicit local provisioning; returns files to save in a protected directory, never system trust. */
export async function generateLocalPki(hostname = 'localhost') {
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(hostname)) throw new Error('Invalid certificate hostname');
  const caKeys = await cryptoApi.generateKey(algorithm, true, ['sign', 'verify']);
  const keys = await cryptoApi.generateKey(algorithm, true, ['sign', 'verify']);
  const validity = { notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 365 * 86400000) };
  const ca = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: serial(), name: 'CN=Homelab Agent CA', ...validity, signingAlgorithm: algorithm, keys: caKeys, extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true)] });
  const server = await x509.X509CertificateGenerator.create({ serialNumber: serial(), subject: `CN=${hostname}`, issuer: ca.subjectName, ...validity, publicKey: keys.publicKey, signingKey: caKeys.privateKey, signingAlgorithm: algorithm, extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true), new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1'], true), new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: hostname }, { type: 'ip', value: '127.0.0.1' }, { type: 'ip', value: '::1' }])] });
  const pemKey = async (key: webcrypto.CryptoKey) => `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await cryptoApi.exportKey('pkcs8', key)).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { ca_pem: ca.toString('pem'), ca_key_pem: await pemKey(caKeys.privateKey), server_pem: server.toString('pem'), server_key_pem: await pemKey(keys.privateKey) };
}
