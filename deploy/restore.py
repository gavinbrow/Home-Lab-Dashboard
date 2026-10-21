"""Verify and extract a backup into a NEW directory; does not dispatch or contact hosts."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
from backup import verify


class BoundedTarInfo(tarfile.TarInfo):
    # PAX/GNU metadata is consumed by tarfile before yielding a member. Bound it
    # before the parser allocates its declared body; the application uses short paths.
    def _proc_pax(self, archive):
        if self.size > 65536:
            raise ValueError('Archive PAX metadata exceeds limit')
        return super()._proc_pax(archive)

    def _proc_gnulong(self, archive):
        if self.size > 65536:
            raise ValueError('Archive GNU metadata exceeds limit')
        return super()._proc_gnulong(archive)


def extract(archive, target, max_bytes=50 * 1024**3, max_entries=100000):
    with tarfile.open(archive, 'r:gz', tarinfo=BoundedTarInfo) as stream:
        members = []
        expanded_bytes = 0
        seen = set()
        for member in stream:
            expanded_bytes += member.size
            if len(members) >= max_entries or expanded_bytes > max_bytes:
                raise ValueError('Archive exceeds configured entry/expanded-byte limits')
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts or '\\' in member.name or ':' in member.name:
                raise ValueError('Unsafe archive member')
            if not member.isfile() and not member.isdir():
                raise ValueError('Archive links and special files are unsupported')
            if member.size < 0 or member.size > max_bytes:
                raise ValueError('Archive member exceeds expanded-byte limit')
            if str(path).casefold() in seen:
                raise ValueError('Duplicate or case-colliding archive path')
            seen.add(str(path).casefold())
            for part in path.parts:
                if (part.endswith(('.', ' ')) or any(char in part for char in '<>"|?*') or
                        re.fullmatch(r'(CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?', part, re.I)):
                    raise ValueError('Nonportable reserved archive path')
            members.append(member)
        Path(target).mkdir(mode=0o700, parents=True, exist_ok=False)
        stream.extractall(target, members=members, filter='data')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    backup = Path(args.backup).resolve(strict=True)
    manifest = verify(backup)
    output = Path(args.output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    for component in manifest['components']:
        if component['status'] != 'CAPTURED':
            continue
        # Never trust component IDs/filenames from an edited manifest.
        cid, name = component['id'], component['file']
        if Path(cid).name != cid or cid in ('.', '..') or Path(name).name != name:
            raise ValueError('Unsafe component')
        if name.endswith('.tar.gz'):
            extract(backup / name, output / cid)
        else:
            import shutil
            shutil.copyfile(backup / name, output / name)
    report = {'backup_set_id': manifest['backup_set_id'], 'coverage': manifest['status'],
              'dispatch_enabled': False, 'restore_mode': True, 'db_restored': False,
              'key_recovery': 'NOT VERIFIED', 'host_reconciliation': 'NOT RUN',
              'end_to_end_drill': 'NOT RUN', 'gaps': manifest['gaps']}
    (output / 'restore-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    return 0 if manifest['status'] == 'STAGED' else 2


if __name__ == '__main__':
    raise SystemExit(main())
