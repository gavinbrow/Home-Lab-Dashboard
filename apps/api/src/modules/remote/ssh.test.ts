import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ssh2, { type SFTPWrapper } from 'ssh2';
import { bridgeTerminal, connectSsh, relativeSftpPath, scopedSftpPath } from './ssh.js';
const {Server,utils} = ssh2;

test('scoped SFTP rejects traversal and canonical symlink escapes',async () => {
  for (const value of ['../secret','a/../secret','/absolute','C:/secret','a\\secret','a\0b'])
    assert.throws(()=>relativeSftpPath(value));
  assert.equal(relativeSftpPath('folder/file.txt'),'folder/file.txt');
  const sftp = {realpath:(path:string,callback:(error:null,result:string)=>void)=>
    callback(null,path==='/root/link' ? '/outside/secret' : path)} as unknown as SFTPWrapper;
  await assert.rejects(scopedSftpPath(sftp,'/root','link'));
  assert.equal(await scopedSftpPath(sftp,'/root','file.txt'),'/root/file.txt');
});

class TestSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent:Array<Record<string,unknown>> = [];
  send(data:string):void {const message=JSON.parse(data);this.sent.push(message);this.emit('sent',message);}
  close():void {if(this.readyState!==1)return;this.readyState=3;this.emit('close');}
}

test('local ssh2 transport authenticates pinned host, echoes PTY bytes and closes on socket revocation', {timeout:15_000}, async t => {
  const privateKey = generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs1'});
  const parsed = utils.parseKey(privateKey);
  assert.ok(!(parsed instanceof Error));
  const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/,'')}`;
  let resized: (size:{cols:number;rows:number})=>void = ()=>{};
  const resize = new Promise<{cols:number;rows:number}>(resolve=>{resized=resolve;});
  const server = new Server({hostKeys:[privateKey]},connection => {
    connection.on('error',()=>{});
    connection.on('authentication',auth => {
      if(auth.method==='password' && auth.username==='local-test' && auth.password==='local-test-only')auth.accept();
      else auth.reject();
    });
    connection.on('ready',()=>connection.on('session',accept => {
      const session=accept();
      session.on('pty',(acceptPty)=>acceptPty?.());
      session.on('window-change',(acceptResize,_reject,info)=>{resized(info);acceptResize?.();});
      session.on('shell',acceptShell=>{const stream=acceptShell();stream.on('data',(data:Buffer)=>stream.write(data));});
    }));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address = server.address();
  assert.ok(address && typeof address==='object');
  const config = {hostname:'127.0.0.1',port:address.port,username:'local-test',hostKeyFingerprints:[fingerprint]};
  await assert.rejects(connectSsh({...config,hostKeyFingerprints:[`SHA256:${Buffer.alloc(32).toString('base64')}`]}, {password:'local-test-only'}));
  const client = await connectSsh(config,{password:'local-test-only'});
  t.after(()=>client.destroy());
  const socket = new TestSocket();
  let closed = false;
  const stop = await bridgeTerminal(client,socket,()=>{closed=true;});
  assert.ok(socket.sent.some(message=>message.type==='ready'));
  const output = new Promise<Buffer>(resolve=>socket.on('sent',message=>{
    if(message.type==='output')resolve(Buffer.from(message.data,'base64'));
  }));
  socket.emit('message',Buffer.from(JSON.stringify({type:'input',data:'Unicode: λ日\u0003'})));
  assert.equal((await output).toString(),'Unicode: λ日\u0003');
  socket.emit('message',Buffer.from(JSON.stringify({type:'resize',cols:130,rows:40})));
  const size = await resize;
  assert.equal(size.cols,130);
  assert.equal(size.rows,40);
  stop();
  assert.equal(closed,true);
  assert.equal(socket.readyState,3);
});
