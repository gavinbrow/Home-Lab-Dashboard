import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class RemoteError extends Error {
  constructor(public readonly code: string, public readonly statusCode = 403) { super(code); }
}

export function verifyHostKey(key: Buffer, trusted: readonly string[]): boolean {
  const actual = createHash('sha256').update(key).digest();
  return trusted.some(value => {
    if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value)) return false;
    const expected = Buffer.from(value.slice(7), 'base64');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}

export function requireOrigin(origin: string | undefined, expected: string): void {
  // Exact match deliberately rejects absent/null origins and sibling subdomains.
  if (origin !== new URL(expected).origin) throw new RemoteError('REMOTE_ORIGIN_DENIED');
}

export function newTicket(): { ticket: string; hash: string } {
  const ticket = randomBytes(32).toString('base64url');
  return { ticket, hash: ticketHash(ticket) };
}
export function ticketHash(ticket: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new RemoteError('REMOTE_TICKET_INVALID');
  return createHash('sha256').update(ticket).digest('hex');
}

export interface DesktopDefinition {
  sessionId: string;
  expiresAt: number;
  protocol: 'rdp' | 'vnc';
  hostname: string;
  port: number;
  username?: string;
  password?: string;
  domain?: string;
}

/** Apache guacamole-auth-json 1.6.0 documented wire encoding; server-side only.
 * Never return this credential-bearing value to a browser or put it in a URL.
 */
export function encryptDesktopDefinition(def: DesktopDefinition, key: Buffer, now = Date.now()): string {
  if (key.length !== 16) throw new RemoteError('GUACAMOLE_KEY_INVALID', 503);
  if (!Number.isSafeInteger(def.expiresAt) || def.expiresAt <= now || def.expiresAt > now + 60_000)
    throw new RemoteError('GUACAMOLE_EXPIRY_INVALID');
  if (!['rdp', 'vnc'].includes(def.protocol) || !def.hostname || /[\s/\\\0]/.test(def.hostname)
    || !Number.isInteger(def.port) || def.port < 1 || def.port > 65535)
    throw new RemoteError('DESKTOP_CONNECTION_INVALID', 400);
  const parameters: Record<string, string> = {
    hostname: def.hostname, port: String(def.port),
    // No drive, SFTP, file-transfer or clipboard capability is inherited implicitly.
    'disable-copy': 'true', 'disable-paste': 'true',
    'enable-drive': 'false', 'enable-sftp': 'false',
  };
  for (const field of ['username', 'password', 'domain'] as const)
    if (def[field] !== undefined) parameters[field] = def[field]!;
  if (def.protocol === 'rdp') { parameters.security = 'nla'; parameters['ignore-cert'] = 'false'; }
  const json = Buffer.from(JSON.stringify({ username: `dashboard-${def.sessionId}`, expires: def.expiresAt,
    connections: { [def.sessionId]: { protocol: def.protocol, parameters } } }));
  const signature = createHmac('sha256', key).update(json).digest();
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16));
  return Buffer.concat([cipher.update(Buffer.concat([signature, json])), cipher.final()]).toString('base64');
}

export interface ActiveRemote {
  ownerId: string;
  authSessionId: string;
  expiresAt: number;
  close: () => void;
}

/** Process-owned transports die on API restart; no session is reattached implicitly. */
export class ActiveRegistry {
  private readonly entries = new Map<string, ActiveRemote>();
  add(id: string, entry: ActiveRemote): void {
    if (this.entries.has(id)) throw new RemoteError('REMOTE_ALREADY_ATTACHED', 409);
    this.entries.set(id, entry);
  }
  remove(id: string): void { this.entries.delete(id); }
  ids(): string[] { return [...this.entries.keys()]; }
  revoke(id: string): void {
    const entry = this.entries.get(id);
    this.entries.delete(id);
    entry?.close();
  }
  revokeAuthSession(authSessionId: string): void {
    for (const [id, entry] of this.entries) if (entry.authSessionId === authSessionId) this.revoke(id);
  }
  expire(now = Date.now()): void {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.revoke(id);
  }
  closeAll(): void { for (const id of this.entries.keys()) this.revoke(id); }
}
