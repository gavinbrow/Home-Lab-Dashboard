import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Workspace } from '@homelab/contracts';
import type { Pool } from 'pg';
import { BlobStore, sha256, relativePath, buildZip, captureCheckpoint, captureCheckpointFromAdapter, exportCheckpoint, withWorkspaceWriter, RootedHostFileAdapter, planRestore, restoreFiles, snapshotManifestHash, previewFile, type WorkspaceFileAdapter } from '../src/index.js';

test('streaming checkpoint and ZIP preserve a file larger than the buffer-object bound',async()=>{
 const root=await mkdtemp(join(tmpdir(),'homelab-stream-'));
 try{
  const store=new BlobStore(root,65536,{maxStreamBytes:8*1024*1024}),bytes=Buffer.alloc(3*1024*1024+19,0xab),hash=sha256(bytes),ws={id:'stream',machine_id:'machine',quota_bytes:8*1024*1024} as Workspace;
  const entry={path:'binary.dat',kind:'file' as const,size_bytes:bytes.length,sha256:hash};let maxRequested=0;
  const adapter={manifest:async()=>({manifest:[entry],consistency:'best_effort' as const,exclusions:[]}),readRange:async(_w:Workspace,_p:string,offset:number,length:number)=>{maxRequested=Math.max(maxRequested,length);const part=bytes.subarray(offset,offset+length);return {bytes:part,offset,total_bytes:bytes.length,sha256:sha256(part),modified_at:null};}} as unknown as WorkspaceFileAdapter;
  const checkpoint=await captureCheckpointFromAdapter(store,ws,adapter);assert.ok(maxRequested<=1048576);assert.deepEqual(checkpoint.manifest,[entry]);
  await assert.rejects(store.get(hash),/unsafe_blob/);
  const archive=await exportCheckpoint(store,checkpoint),parts:Buffer[]=[];
  for(let offset=0;offset<archive.size;){const part=await store.readRange(archive.hash,offset,1048576);parts.push(part.bytes);offset+=part.bytes.length;}
  const zip=Buffer.concat(parts);assert.equal(sha256(zip),archive.hash);assert.equal(zip.readUInt32LE(0),0x04034b50);assert.equal(zip.readUInt16LE(6),0x808);
  const start=30+zip.readUInt16LE(26);assert.deepEqual(zip.subarray(start,start+bytes.length),bytes);assert.equal(zip.readUInt32LE(start+bytes.length),0x08074b50);assert.equal(zip.readUInt32LE(zip.length-22),0x06054b50);assert.equal(zip.readUInt16LE(zip.length-14),2);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('portable paths reject traversal, UNC, ADS and Windows device forms', () => {
  for (const path of ['../x', '/etc/passwd', 'C:/x', '\\server\\share', 'x\\y', 'a/../b', 'a//b', 'nul.txt', 'x:secret', 'a.', 'a ', 'a/CON', 'a\0b', 'CONIN$', 'COM0', 'COM¹.txt']) {
    assert.throws(() => relativePath(path), /invalid_relative_path/);
  }
  assert.equal(relativePath('.git/config'), '.git/config');
  assert.equal(relativePath('binary/output.bin'), 'binary/output.bin');
});

test('host adapter preserves empty binary files and verifies RPC bytes', async () => {
  const workspace = { id: 'x', machine_id: 'host', quota_bytes: 10000 } as Workspace;
  const empty = Buffer.alloc(0);
  const adapter = new RootedHostFileAdapter(async (machine, method, route) => {
    assert.equal(machine, 'host');
    assert.equal(method, 'GET');
    if (route.endsWith('/snapshot')) return { files: [{ entry: { path: 'empty.bin', kind: 'file', sha256: sha256(empty), size_bytes: 0 } }], consistency: 'best_effort', exclusions: [] };
    return { content_base64: 'eA==', sha256: sha256(Buffer.from('different')), size_bytes: 1 };
  });
  const snapshot = await adapter.snapshot(workspace);
  assert.deepEqual(snapshot.files[0].bytes, empty);
  await assert.rejects(adapter.read(workspace, 'file.txt'), /host_file_checksum_mismatch/);
  await assert.rejects(adapter.read(workspace, '../escape'), /invalid_relative_path/);
});

test('immutable content hashes survive mutable source changes; corrupt blobs fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homelab-blobs-'));
  try {
    const store = new BlobStore(root, 2048);
    const original = Buffer.from([0, 1, 255]);
    const blob = await store.put(original);
    original[0] = 44;
    assert.deepEqual(await store.get(blob.hash), Buffer.from([0, 1, 255]));
    assert.deepEqual(await store.put(Buffer.from([0, 1, 255])), blob);
    await assert.rejects(store.put(Buffer.from('x'), '0'.repeat(64)), /checksum_mismatch/);
    await assert.rejects(store.put(Buffer.alloc(2049)), error => (error as { code: string }).code === 'blob_quota_exceeded');
    await writeFile(join(root, blob.hash.slice(0, 2), blob.hash), 'bad');
    await assert.rejects(store.get(blob.hash), /blob_integrity_failure/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkpoint includes hidden/untracked/binary files and records links without following them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homelab-checkpoint-'));
  try {
    const store = new BlobStore(root);
    const workspace = { id: 'workspace', quota_bytes: 10000 } as Workspace;
    const bytes = Buffer.from([0, 255, 42]);
    const checkpoint = await captureCheckpoint(store, workspace, {
      consistency: 'best_effort', exclusions: ['cache'], files: [
        { entry: { path: 'untracked.bin', kind: 'file', sha256: sha256(bytes), size_bytes: bytes.length }, bytes },
        { entry: { path: '.hidden', kind: 'file', sha256: null, size_bytes: 1 }, bytes: Buffer.from('x') },
        { entry: { path: 'external', kind: 'symlink', sha256: null, size_bytes: 0, link_target: '/outside' } },
      ],
    });
    assert.equal(checkpoint.manifest.length, 3);
    const exported = await exportCheckpoint(store, checkpoint);
    const zip = await store.get(exported.hash);
    assert.equal(zip.readUInt32LE(), 0x04034b50);
    assert.ok(zip.includes(Buffer.from('untracked.bin')));
    assert.ok(zip.includes(Buffer.from('.homelab-export-manifest.json')));
    await assert.rejects(exportCheckpoint(store, { ...checkpoint, consistency: 'consistent' }), /checkpoint_manifest_mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ZIP names cannot escape and case collisions and limits are rejected', () => {
  assert.throws(() => buildZip([{ path: '../escape', bytes: Buffer.alloc(0) }]), /invalid_relative_path/);
  assert.throws(() => buildZip([{ path: 'A', bytes: Buffer.alloc(0) }, { path: 'a', bytes: Buffer.alloc(0) }]), /duplicate_archive_path/);
  assert.throws(() => buildZip([{ path: 'a', bytes: Buffer.alloc(128) }], 64), /export_quota_exceeded/);
});

test('ambiguous host write retains its reservation; definitive stale save releases it', async () => {
  const queries: string[] = [];
  const query = async (sql: string) => {
    queries.push(sql);
    if (sql.startsWith('SELECT state')) return { rows: [{ state: 'active', revision: 1 }], rowCount: 1 };
    return { rows: [{ workspace_id: 'x' }], rowCount: 1 };
  };
  const db = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const workspace = { id: 'x', revision: 1 } as Workspace;
  await assert.rejects(withWorkspaceWriter(db, workspace, 'owner', 'file.write', async () => { throw new Error('connection reset after send'); }));
  assert.ok(queries.some(sql => sql.includes("state='outcome_unknown'")));
  assert.ok(!queries.some(sql => sql.startsWith('DELETE')));
  queries.length = 0;
  await assert.rejects(withWorkspaceWriter(db, workspace, 'owner', 'file.write', async () => { throw Object.assign(new Error('stale'), { code: 'content_conflict' }); }));
  assert.ok(queries.some(sql => sql.startsWith('DELETE')));
});

test('restore review preserves unselected paths and removes extra files only explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homelab-restore-'));
  try {
    const store = new BlobStore(root);
    const workspace = { id: 'workspace', quota_bytes: 10000 } as Workspace;
    const binary = Buffer.from([0, 255, 200]);
    const target = await captureCheckpoint(store, workspace, { consistency: 'best_effort', exclusions: [], files: [{ entry: { path: 'untracked.bin', kind: 'file', sha256: sha256(binary), size_bytes: binary.length, mode: 420 }, bytes: binary }] });
    const current = { consistency: 'best_effort' as const, exclusions: [], files: [
      { entry: { path: 'untracked.bin', kind: 'file' as const, sha256: sha256(Buffer.from('changed')), size_bytes: 7, mode: 420 }, bytes: Buffer.from('changed') },
      { entry: { path: 'new-user-file', kind: 'file' as const, sha256: sha256(Buffer.from('keep')), size_bytes: 4, mode: 420 }, bytes: Buffer.from('keep') },
    ] };
    const preserve = planRestore(target, current, null, false);
    assert.deepEqual(preserve.write_paths, ['untracked.bin']);
    assert.deepEqual(preserve.delete_paths, []);
    const whole = planRestore(target, current, null, true);
    assert.deepEqual(whole.delete_paths, ['new-user-file']);
    assert.notEqual(whole.plan_hash, preserve.plan_hash);
    const selected = planRestore(target, current, ['untracked.bin'], true);
    assert.deepEqual(selected.delete_paths, []);
    assert.deepEqual((await restoreFiles(store, target, selected))[0].bytes, binary);
    assert.throws(() => planRestore(target, { ...current, exclusions: ['unreadable'] }, null, true), /exclusions/);
    assert.throws(() => planRestore(target, current, ['../outside'], true), /invalid_relative_path/);
    assert.throws(() => planRestore(target, current, ['absent'], true), /absent/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host manifest precondition is deterministic across JSONB ordering and directory sizes', () => {
  const a = { path: 'a&b', kind: 'file' as const, sha256: '0'.repeat(64), size_bytes: 1, mode: 420 };
  const b = { mode: 420, sha256: '0'.repeat(64), size_bytes: 1, kind: 'file' as const, path: 'a&b' };
  assert.equal(snapshotManifestHash([a]), snapshotManifestHash([b]));
  assert.equal(snapshotManifestHash([{ path: 'dir', kind: 'directory', sha256: null, size_bytes: 17, mode: 493 }]), snapshotManifestHash([{ path: 'dir', kind: 'directory', sha256: null, size_bytes: 0, mode: 493 }]));
  assert.notEqual(snapshotManifestHash([a]), snapshotManifestHash([{ ...a, sha256: '1'.repeat(64) }]));
});

test('active-content formats remain plain text preview data', () => {
  assert.deepEqual(previewFile(Buffer.from('<svg onload="evil()"/>'), 'x.svg'), { kind: 'text', mime_type: 'text/plain', text: '<svg onload="evil()"/>' });
  assert.equal(previewFile(Buffer.from([0, 255]), 'unknown.bin').kind, 'download');
  assert.equal(previewFile(Buffer.from('{broken}'), 'x.json').kind, 'text');
  const csv = previewFile(Buffer.from('name,value\n"quoted,name","line1\nline2"\n"a""b",3'), 'x.csv');
  assert.equal(csv.kind, 'csv');
  assert.deepEqual('rows' in csv ? csv.rows : [], [['name', 'value'], ['quoted,name', 'line1\nline2'], ['a"b', '3']]);
  const limited = previewFile(Buffer.from(Array.from({ length: 500 }, (_, index) => `${index},value`).join('\n')), 'x.csv');
  assert.equal('rows' in limited ? limited.rows.length : 0, 201);
  assert.equal('truncated' in limited ? limited.truncated : false, true);
});

test('reviewed type replacement requires deletion consent and nested restore includes absent parents', () => {
  const target = { id: 'target', workspace_id: 'ws', manifest_hash: 'a'.repeat(64), consistency: 'best_effort' as const, exclusions: [], created_at: '', manifest: [{ path: 'nested', kind: 'directory' as const, sha256: null, size_bytes: 0, mode: 493 }, { path: 'nested/report', kind: 'file' as const, sha256: '1'.repeat(64), size_bytes: 1, mode: 420 }] };
  const empty = { files: [], consistency: 'best_effort' as const, exclusions: [] };
  assert.deepEqual(planRestore(target, empty, ['nested/report'], false).write_paths, ['nested', 'nested/report']);
  const wrongKind = { ...empty, files: [{ entry: { path: 'nested', kind: 'file' as const, sha256: '0'.repeat(64), size_bytes: 1, mode: 420 }, bytes: Buffer.from('x') }] };
  assert.throws(() => planRestore(target, wrongKind, null, false), /File type changed/);
  const replace = planRestore(target, wrongKind, null, true);
  assert.deepEqual(replace.replace_paths, ['nested']);
  assert.deepEqual(replace.delete_paths, ['nested']);
});

test('host pagination forwards cursor/hidden filter and preserves actual modified timestamp', async () => {
  const ws = { id: 'workspace', machine_id: 'machine', quota_bytes: 1000 } as Workspace;
  const adapter = new RootedHostFileAdapter(async (_machine, method, route) => {
    assert.equal(method, 'GET');
    const url = new URL(route, 'http://unused');
    assert.equal(url.searchParams.get('mode'), 'page');
    assert.equal(url.searchParams.get('cursor'), 'before');
    assert.equal(url.searchParams.get('include_hidden'), 'false');
    return { items: [{ path: 'file', kind: 'file', size_bytes: 2, sha256: null, modified_at: '2026-10-21T00:00:00Z' }], next_cursor: 'file' };
  });
  const page = await adapter.listPage(ws, '', { limit: 100, cursor: 'before', include_hidden: false });
  assert.equal(page.next_cursor, 'file');
  assert.equal(page.items[0].modified_at, '2026-10-21T00:00:00Z');
});

test('host conflict releases no lock without explicit proof that effects never began', async () => {
  const workspace = { id: 'x', machine_id: 'host', quota_bytes: 10000 } as Workspace;
  const mutation = { operation_id: 'operation' };
  const unknown = new RootedHostFileAdapter(async () => ({ operation_id: 'operation', state: 'conflict', error: 'file_conflict' }));
  await assert.rejects(unknown.quarantine(workspace, 'file', '0'.repeat(64), mutation), error => (error as { code: string }).code === 'host_outcome_unknown');
  const preflight = new RootedHostFileAdapter(async () => ({ operation_id: 'operation', state: 'conflict', error: 'file_conflict', effects_started: false }));
  await assert.rejects(preflight.quarantine(workspace, 'file', '0'.repeat(64), mutation), error => (error as { code: string }).code === 'content_conflict');
});
