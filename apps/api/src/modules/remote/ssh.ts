import ssh2, { type ClientChannel, type SFTPWrapper } from 'ssh2';
import { posix } from 'node:path';
import { RemoteError, verifyHostKey } from './security.js';
const { Client } = ssh2;
type Client = import('ssh2').Client;

export interface SshConnection {
  hostname: string; port: number; username: string; hostKeyFingerprints: string[];
  sftpRoot?: string;
  /** Must be tested host-side account/chroot confinement, not inferred from cwd. */
  sftpConfinementVerified?: boolean;
}
export interface SshCredential { password?: string; privateKey?: string; passphrase?: string }

export async function connectSsh(config: SshConnection, secret: SshCredential): Promise<Client> {
  if (!config.hostKeyFingerprints.length) throw new RemoteError('SSH_HOST_KEY_UNVERIFIED', 409);
  if (!config.hostname || /[\s/\\\0]/.test(config.hostname) || !Number.isInteger(config.port)
    || config.port < 1 || config.port > 65535 || !config.username)
    throw new RemoteError('SSH_CONNECTION_INVALID', 400);
  if (!secret.password && !secret.privateKey) throw new RemoteError('SSH_CREDENTIAL_INVALID', 409);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let ready = false;
    client.on('error', () => {
      // ssh2 errors may contain endpoint/account information; never forward raw messages.
      if (!ready) { client.destroy(); reject(new RemoteError('SSH_CONNECTION_FAILED', 502)); }
    });
    client.once('ready', () => { ready = true; resolve(client); });
    client.connect({ host: config.hostname, port: config.port, username: config.username,
      ...(secret.privateKey ? { privateKey: secret.privateKey, passphrase: secret.passphrase } : { password: secret.password }),
      hostVerifier: (key:Buffer) => verifyHostKey(key, config.hostKeyFingerprints),
      readyTimeout: 15_000, keepaliveInterval: 15_000, keepaliveCountMax: 2,
      agentForward: false, tryKeyboard: false,
    });
  });
}

export interface TerminalSocket {
  readyState: number; bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

export async function bridgeTerminal(client: Client, socket: TerminalSocket, onClose: () => void): Promise<() => void> {
  let stream: ClientChannel | undefined;
  let closed = false;
  let lastInput = Date.now();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(idle);
    stream?.destroy(); client.destroy();
    socket.close(1000, 'Terminal closed');
    onClose();
  };
  const idle = setInterval(() => { if (Date.now() - lastInput > 15 * 60_000) close(); }, 10_000);
  idle.unref();
  socket.on('close', close); socket.on('error', close); client.on('close', close); client.on('error', close);
  socket.on('message', raw => {
    if (closed) return;
    const text = raw.toString();
    if (Buffer.byteLength(text) > 32_768) { close(); return; }
    try {
      const message: unknown = JSON.parse(text);
      if (!message || typeof message !== 'object') { close(); return; }
      const frame = message as Record<string, unknown>;
      if (frame.type === 'input' && typeof frame.data === 'string' && Buffer.byteLength(frame.data) <= 8192) {
        lastInput = Date.now();
        if (!stream || stream.writableLength > 65_536) { close(); return; }
        stream.write(frame.data);
      } else if (frame.type === 'resize' && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)
        && Number(frame.cols) >= 2 && Number(frame.cols) <= 500 && Number(frame.rows) >= 1 && Number(frame.rows) <= 200) {
        stream?.setWindow(Number(frame.rows), Number(frame.cols), 0, 0);
      } else close();
    } catch { close(); }
  });
  try {
    stream = await new Promise<ClientChannel>((resolve, reject) => client.shell(
      { term: 'xterm-256color', cols: 100, rows: 30 }, (error, channel) => error ? reject(error) : resolve(channel)));
    if (closed) { stream.destroy(); return close; }
    const output = (data: Buffer) => {
      if (socket.readyState !== 1 || socket.bufferedAmount > 1_048_576) { close(); return; }
      // Base64 preserves split UTF-8 and all control bytes; xterm consumes Uint8Array.
      socket.send(JSON.stringify({ type: 'output', encoding: 'base64', data: data.toString('base64') }));
    };
    stream.on('data', output); stream.stderr.on('data', output); stream.on('close', close);
    socket.send(JSON.stringify({ type: 'ready' }));
    return close;
  } catch { close(); throw new RemoteError('SSH_SHELL_FAILED', 502); }
}

export async function openSftp(client: Client, config: SshConnection): Promise<SFTPWrapper> {
  if (!config.sftpConfinementVerified || !config.sftpRoot)
    throw new RemoteError('SFTP_ACCOUNT_CONFINEMENT_UNVERIFIED', 409);
  return new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(new RemoteError('SFTP_UNAVAILABLE', 502)) : resolve(sftp)));
}

export function relativeSftpPath(value: string): string {
  if (value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/')
    || value.split('/').some(segment => segment === '..') || value.length > 2048)
    throw new RemoteError('SFTP_PATH_DENIED');
  return posix.normalize(value || '.');
}

/** Defense in depth; chroot/OS permissions remain necessary against rename/symlink races. */
export async function scopedSftpPath(sftp: SFTPWrapper, root: string, relative: string): Promise<string> {
  const realpath = (path: string) => new Promise<string>((resolve, reject) =>
    sftp.realpath(path, (error, canonical) => error ? reject(new RemoteError('SFTP_PATH_UNAVAILABLE', 404)) : resolve(canonical)));
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(posix.join(canonicalRoot, relativeSftpPath(relative)));
  if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`))
    throw new RemoteError('SFTP_PATH_DENIED');
  return canonical;
}

export class ConfinedSftp {
  private constructor(private readonly sftp:SFTPWrapper, private readonly root:string) {}
  static async open(client:Client, config:SshConnection):Promise<ConfinedSftp> {
    return new ConfinedSftp(await openSftp(client,config),config.sftpRoot!);
  }
  close():void {this.sftp.end();}
  async list(relative:string):Promise<Array<{name:string;size:number;directory:boolean;symlink:boolean}>> {
    const path = await scopedSftpPath(this.sftp,this.root,relative);
    const handle = await new Promise<Buffer>((resolve,reject)=>this.sftp.opendir(path,(error,value)=>
      error ? reject(new RemoteError('SFTP_READ_FAILED',502)) : resolve(value)));
    type Entry = { filename:string; attrs:{size:number;isDirectory():boolean;isSymbolicLink():boolean} };
    const entries:Entry[] = [];
    try {
      while (true) {
        const batch = await new Promise<Entry[]|false>((resolve,reject)=>this.sftp.readdir(handle,(error,items)=>
          error ? Number((error as Error&{code?:number}).code)===1 ? resolve(false) : reject(new RemoteError('SFTP_READ_FAILED',502)) : resolve(items)));
        if (!batch || !batch.length) break;
        if (entries.length+batch.length>1000) throw new RemoteError('SFTP_DIRECTORY_TOO_LARGE',413);
        entries.push(...batch);
      }
      return entries.filter(entry => entry.filename!=='.' && entry.filename!=='..').map(entry => ({
        name:entry.filename,size:entry.attrs.size,directory:entry.attrs.isDirectory(),symlink:entry.attrs.isSymbolicLink(),
      }));
    } finally {
      await new Promise<void>(resolve=>this.sftp.close(handle,()=>resolve()));
    }
  }
  async read(relative:string):Promise<Buffer> {
    const path = await scopedSftpPath(this.sftp,this.root,relative);
    return new Promise((resolve,reject) => {
      const stream = this.sftp.createReadStream(path);
      const chunks:Buffer[] = [];
      let size = 0;
      const timeout = setTimeout(()=>{reject(new RemoteError('SFTP_READ_TIMEOUT',504));stream.destroy();},30_000);
      timeout.unref();
      stream.on('data',(chunk:Buffer) => {
        size+=chunk.length;
        if (size>4_194_304) stream.destroy(new Error('limit'));
        else chunks.push(chunk);
      });
      stream.once('error',()=>{clearTimeout(timeout);reject(new RemoteError('SFTP_READ_FAILED_OR_LIMIT',502));});
      stream.once('end',()=>{clearTimeout(timeout);resolve(Buffer.concat(chunks));});
    });
  }
  /** New-file upload only: never silently overwrite a concurrent edit or follow an existing link. */
  async create(relative:string, data:Buffer):Promise<void> {
    if (data.length>4_194_304) throw new RemoteError('SFTP_UPLOAD_TOO_LARGE',413);
    const safe = relativeSftpPath(relative);
    if (safe==='.' || safe.endsWith('/')) throw new RemoteError('SFTP_PATH_DENIED');
    const parent = await scopedSftpPath(this.sftp,this.root,posix.dirname(safe));
    const target = posix.join(parent,posix.basename(safe));
    await new Promise<void>((resolve,reject) => {
      const stream = this.sftp.createWriteStream(target,{flags:'wx',mode:0o600});
      const timeout = setTimeout(()=>{reject(new RemoteError('SFTP_CREATE_TIMEOUT',504));stream.destroy();},30_000);
      timeout.unref();
      stream.once('error',()=>{clearTimeout(timeout);reject(new RemoteError('SFTP_CREATE_FAILED',409));});
      stream.once('close',()=>{clearTimeout(timeout);resolve();});
      stream.end(data);
    });
  }
}
