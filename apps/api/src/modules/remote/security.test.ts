import assert from 'node:assert/strict';
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { ActiveRegistry, encryptDesktopDefinition, newTicket, requireOrigin, ticketHash, verifyHostKey } from './security.ts';

test('SSH pins exact raw host-key SHA256, refusing missing, malformed and changed pins', () => {
  const key = Buffer.from('test-public-host-key');
  const pin = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/,'')}`;
  assert.equal(verifyHostKey(key,[pin]),true);
  assert.equal(verifyHostKey(Buffer.from('changed-key'),[pin]),false);
  assert.equal(verifyHostKey(key,[]),false);
  assert.equal(verifyHostKey(key,['SHA256:not-valid']),false);
});

test('browser transport demands exact configured Origin', () => {
  requireOrigin('https://lab.example','https://lab.example');
  for (const origin of [undefined,'null','https://lab.example.evil.test','http://lab.example','https://other.example'])
    assert.throws(()=>requireOrigin(origin,'https://lab.example'));
});

test('launch tickets are random, fixed length, and persisted only by hash', () => {
  const a = newTicket(), b = newTicket();
  assert.equal(a.ticket.length,43);
  assert.notEqual(a.ticket,b.ticket);
  assert.notEqual(a.ticket,a.hash);
  assert.equal(ticketHash(a.ticket),a.hash);
  assert.throws(()=>ticketHash('bad'));
});

test('Guacamole 1.6.0 JSON encoding decrypts to HMAC + one scoped connection', () => {
  const key = Buffer.from('4C0B569E4C96DF157EEE1B65DD0E4D41','hex');
  const now = 1_700_000_000_000;
  const encoded = encryptDesktopDefinition({sessionId:'session-test',expiresAt:now+30_000,protocol:'rdp',
    hostname:'configured-host.example',port:3389,username:'restricted-user',password:'private-password'},key,now);
  assert.equal(encoded.includes('private-password'),false);
  const decipher = createDecipheriv('aes-128-cbc',key,Buffer.alloc(16));
  const decoded = Buffer.concat([decipher.update(Buffer.from(encoded,'base64')),decipher.final()]);
  const signature = decoded.subarray(0,32), json = decoded.subarray(32);
  assert.deepEqual(signature,createHmac('sha256',key).update(json).digest());
  const payload = JSON.parse(json.toString());
  assert.equal(payload.expires,now+30_000);
  assert.deepEqual(Object.keys(payload.connections),['session-test']);
  assert.equal(payload.connections['session-test'].parameters['ignore-cert'],'false');
  assert.equal(payload.connections['session-test'].parameters['enable-drive'],'false');
  assert.throws(()=>encryptDesktopDefinition({sessionId:'s',expiresAt:now,protocol:'vnc',hostname:'host',port:5900},key,now));
  assert.throws(()=>encryptDesktopDefinition({sessionId:'s',expiresAt:now+60_001,protocol:'vnc',hostname:'host',port:5900},key,now));
});

test('active transports close on revocation, auth logout, expiry and process shutdown', () => {
  const registry = new ActiveRegistry();
  const closed:string[] = [];
  for (const [id,auth,expires] of [['a','login1',100],['b','login1',200],['c','login2',300]] as const)
    registry.add(id,{ownerId:'owner',authSessionId:auth,expiresAt:expires,close:()=>closed.push(id)});
  assert.throws(()=>registry.add('a',{ownerId:'owner',authSessionId:'login1',expiresAt:100,close:()=>{}}));
  registry.revoke('a'); registry.revoke('a');
  assert.deepEqual(closed,['a']);
  registry.revokeAuthSession('login1');
  assert.deepEqual(closed,['a','b']);
  registry.expire(300);
  assert.deepEqual(closed,['a','b','c']);
  registry.add('d',{ownerId:'owner',authSessionId:'login2',expiresAt:400,close:()=>closed.push('d')});
  registry.closeAll();
  assert.deepEqual(closed,['a','b','c','d']);
});
