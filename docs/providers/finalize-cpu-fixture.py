"""Repair materialized SONAME aliases after initial verified extraction link ordering error.

Does not download bytes. Only operates on the exact explicit fixture root argument.
The initial extractor reached its post-checksum link materialization branch.
"""
from pathlib import Path
import hashlib
import json
import shutil
import sys
root=Path(sys.argv[1]).resolve()
library=root/'lib/ollama'
for source in list(library.glob('*.so.*')):
    suffix=source.name.split('.so.',1)[1]
    if '.' not in suffix: continue
    for alias in [source.name.split('.so.',1)[0]+'.so',source.name.split('.so.',1)[0]+'.so.'+suffix.split('.')[0]]:
        target=library/alias
        if not target.exists(): shutil.copyfile(source,target)
files=[{'path':str(path.relative_to(root)).replace('\\','/'),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}for path in root.rglob('*')if path.is_file()and path.name!='source-manifest.json']
size=sum(item['bytes']for item in files)
if size>512*1024*1024:raise RuntimeError('Fixture footprint exceeds CPU extraction bound')
manifest={'source_url':'https://github.com/ollama/ollama/releases/download/v0.40.6/ollama-linux-amd64.tar.zst','release':'0.40.6','archive_bytes':1438364593,'archive_sha256':'c164ab8b1b28e2a247c29719b8e404c423c5b83ae64c3ab4e59d50c7ff7fc5e0','verification':'initial extractor passed full archive size and SHA assertion before failing while resolving chained symlinks; no second transfer','soname_alias_repair':'versioned CPU libraries copied to standard SONAME filenames; only local fixture','cpu_retained_bytes':size,'files':files,'scope':'isolated CPU-only test fixture'}
(root/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'cpu_retained_bytes':size,'files':len(files)}))
