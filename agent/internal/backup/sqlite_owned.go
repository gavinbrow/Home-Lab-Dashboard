package backup

import (
	"context"
	"database/sql"
	"errors"
	"homelab/agent/internal/files"
	"os"
)

// SnapshotOwnedSQLite uses the existing owner connection. On POSIX, opening and
// closing ANY additional raw descriptor on the database can release that process's
// fcntl locks, so this route deliberately performs no raw source-file access.
func SnapshotOwnedSQLite(ctx context.Context, db *sql.DB, destination string, maxBytes int64) error {
	var pages, size int64
	if e := db.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages); e != nil {
		return e
	}
	if e := db.QueryRowContext(ctx, "PRAGMA page_size").Scan(&size); e != nil {
		return e
	}
	if size < 1 || pages > maxBytes/size {
		return errors.New("sqlite_snapshot_quota")
	}
	_, e := db.ExecContext(ctx, "VACUUM INTO ?", destination)
	return e
}
func (w *captureWriter) liveSQLite(root Root, name, archivePath, absolute string, snapshot func(context.Context, string, int64) error, emit bool) error {
	metadata, e := files.CaptureProtectedPathNativeMetadataNoOpen(absolute)
	if e != nil {
		return e
	}
	w.noteMetadata(metadata)
	entry := Entry{NativeMetadata: &metadata, Path: "roots/" + root.ID + "/" + archivePath, RootID: root.ID, Kind: "file", Mode: metadata.Mode, ModifiedAt: "", Consistency: "sqlite_vacuum_into", SHA256: "sqlite_snapshot"}
	if !emit {
		return w.addFingerprint(entry)
	}
	f, e := os.CreateTemp(w.snapshots, "owned-sqlite-")
	if e != nil {
		return e
	}
	path := f.Name()
	f.Close()
	os.Remove(path)
	defer os.Remove(path)
	if e = snapshot(w.ctx, path, w.manager.cfg.MaxBundleBytes); e != nil {
		return e
	}
	if e = os.Chmod(path, 0600); e != nil {
		return e
	}
	file, e := os.Open(path)
	if e != nil {
		return e
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil {
		return e
	}
	if info.Size() > w.manager.cfg.MaxBundleBytes {
		return errors.New("sqlite_snapshot_quota")
	}
	entry.SizeBytes = info.Size()
	if e = w.addFingerprint(entry); e != nil {
		return e
	}
	entry.SHA256, e = hashFile(w.ctx, file)
	if e != nil {
		return e
	}
	if _, e = file.Seek(0, 0); e != nil {
		return e
	}
	return w.emit(entry, file)
}
