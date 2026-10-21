"""Extract a bounded CPU-only test fixture from a checksum-pinned official release.

Requires the already available Python zstandard library. Does not install software.
GPU directories and the compressed archive are never written to disk.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import urllib.request
import zstandard

URL = 'https://github.com/ollama/ollama/releases/download/v0.40.6/ollama-linux-amd64.tar.zst'
EXPECTED_SIZE = 1438364593
EXPECTED_SHA = 'c164ab8b1b28e2a247c29719b8e404c423c5b83ae64c3ab4e59d50c7ff7fc5e0'
target = Path(sys.argv[1]).resolve()
if target.exists():
    raise SystemExit('Use a new dedicated fixture output directory')
target.mkdir(parents=True)
digest = hashlib.sha256()

class Reader:
    def __init__(self, response): self.response = response; self.count = 0
    def read(self, size=-1):
        value = self.response.read(size); self.count += len(value)
        if self.count > EXPECTED_SIZE: raise RuntimeError('Unexpected larger archive; stopping')
        digest.update(value)
        return value

files = []
links = []
retained = 0
with urllib.request.urlopen(URL, timeout=120) as response:
    if int(response.headers.get('content-length', EXPECTED_SIZE)) != EXPECTED_SIZE:
        raise RuntimeError('Upstream size differs from verified release metadata')
    reader = Reader(response)
    with zstandard.ZstdDecompressor().stream_reader(reader) as stream:
        with tarfile.open(fileobj=stream, mode='r|') as archive:
            for member in archive:
                name = PurePosixPath(member.name.removeprefix('./'))
                if name.is_absolute() or '..' in name.parts: raise RuntimeError('Unsafe archive member')
                # Official Dockerfile places CPU libraries and llama-server directly
                # in lib/ollama; all CUDA/ROCm/Vulkan/MLX payloads use subdirectories.
                selected = str(name) == 'bin/ollama' or len(name.parts) == 3 and name.parts[:2] == ('lib', 'ollama')
                if not selected or member.isdir(): continue
                path = target.joinpath(*name.parts)
                if member.issym() or member.islnk(): links.append((path, member.linkname, member.islnk())); continue
                if not member.isfile(): raise RuntimeError('Unexpected CPU payload file type')
                retained += member.size
                if retained > 512 * 1024 * 1024: raise RuntimeError('CPU footprint exceeded 512 MiB; stopping')
                path.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None: raise RuntimeError('Missing archive payload')
                file_hash = hashlib.sha256()
                with path.open('wb') as output:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        output.write(block); file_hash.update(block)
                files.append({'path': str(name), 'bytes': member.size, 'sha256': file_hash.hexdigest()})
                print(json.dumps({'retained': str(name), 'bytes': member.size}), flush=True)
        # Verify all compressed bytes, including footer/trailer; tar stops at its end marker.
        while stream.read(1024 * 1024): pass
    while reader.read(1024 * 1024): pass
if reader.count != EXPECTED_SIZE or digest.hexdigest() != EXPECTED_SHA:
    raise RuntimeError('Official archive checksum mismatch; fixture must not execute')
print(json.dumps({'archive_verified': True, 'archive_sha256': digest.hexdigest(), 'archive_bytes': reader.count}), flush=True)
pending = list(links)
while pending:
    progressed = False
    for entry in pending[:]:
        path, link, hard = entry
        source = (target / link if hard else path.parent / link).resolve()
        if not source.is_relative_to(target): raise RuntimeError('Unsafe CPU library link')
        if not source.is_file(): continue
        shutil.copyfile(source, path)
        retained += path.stat().st_size
        pending.remove(entry)
        progressed = True
    if not progressed: raise RuntimeError('Unresolved CPU library link chain')
if retained > 512 * 1024 * 1024: raise RuntimeError('Materialized CPU footprint exceeded 512 MiB')
if not (target / 'bin/ollama').is_file() or not (target / 'lib/ollama/llama-server').is_file():
    raise RuntimeError('Expected official CPU entry points absent')
manifest = {'source_url': URL, 'release': '0.40.6', 'archive_bytes': reader.count, 'archive_sha256': digest.hexdigest(), 'cpu_retained_bytes': retained, 'files': files, 'materialized_library_links': len(links), 'scope': 'isolated CPU-only test fixture; not a distributed official Docker image'}
(target / 'source-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
print(json.dumps({'verified': True, 'cpu_retained_bytes': retained}), flush=True)
