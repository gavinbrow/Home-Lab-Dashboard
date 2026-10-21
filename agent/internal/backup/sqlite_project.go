package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Live SQLite paths are never reopened with privileged path-based SQLite APIs.
// Copy the approved already-open inode and rooted WAL into protected storage first.
// This path requires the host writer barrier or explicit operator quiescence assertion; unquiesced inputs
// are exported as ordinary rooted files with incomplete coverage instead.
func (w *captureWriter) cloneProjectSQLite(root *os.Root, name string, source *os.File) (string, string, error) {
	dir, e := os.MkdirTemp(w.snapshots, "project-sqlite-")
	if e != nil {
		return "", "", e
	}
	ok := false
	defer func() {
		if !ok {
			os.RemoveAll(dir)
		}
	}()
	destination := filepath.Join(dir, "source.db")
	copyFile := func(input *os.File, out string) (string, error) {
		before, e := input.Stat()
		if e != nil || !before.Mode().IsRegular() || before.Size() > w.manager.cfg.MaxBundleBytes {
			return "", errors.New("sqlite_source_invalid_or_too_large")
		}
		if _, e = input.Seek(0, io.SeekStart); e != nil {
			return "", e
		}
		output, e := os.OpenFile(out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return "", e
		}
		defer output.Close()
		h := sha256.New()
		n, e := io.Copy(io.MultiWriter(output, h), io.LimitReader(&contextReader{w.ctx, input}, w.manager.cfg.MaxBundleBytes+1))
		if e != nil {
			return "", e
		}
		if n != before.Size() {
			return "", errors.New("sqlite_source_changed")
		}
		after, e := input.Stat()
		if e != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
			return "", errors.New("sqlite_source_changed")
		}
		if e = output.Sync(); e != nil {
			return "", e
		}
		return hex.EncodeToString(h.Sum(nil)), nil
	}
	dbHash, e := copyFile(source, destination)
	if e != nil {
		return "", "", e
	}
	walHash := "absent"
	info, e := root.Lstat(name + "-wal")
	if e == nil {
		if !info.Mode().IsRegular() || isLink(info) {
			return "", "", errors.New("unsafe_project_wal")
		}
		wal, e := openRegular(root, name+"-wal")
		if e != nil {
			return "", "", e
		}
		walHash, e = copyFile(wal, destination+"-wal")
		wal.Close()
		if e != nil {
			return "", "", e
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return "", "", e
	}
	hash := sha256.Sum256([]byte(dbHash + ":" + walHash))
	ok = true
	return destination, hex.EncodeToString(hash[:]), nil
}
