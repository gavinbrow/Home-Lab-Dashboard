package files

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"time"
)

const MaxRangeBytes int64 = 1 << 20

// Manifest contains hashes rather than retained file bytes. Callers verify the
// manifest again after downloading ranges to detect unrelated native writers.
type Manifest struct {
	Manifest    []Entry  `json:"manifest"`
	Consistency string   `json:"consistency"`
	Exclusions  []string `json:"exclusions"`
}
type FileRange struct {
	Content    []byte `json:"content_base64"`
	SHA256     string `json:"sha256"`
	Offset     int64  `json:"offset"`
	TotalBytes int64  `json:"total_bytes"`
	ModifiedAt string `json:"modified_at"`
}
type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (c contextReader) Read(p []byte) (int, error) {
	select {
	case <-c.ctx.Done():
		return 0, c.ctx.Err()
	default:
		return c.r.Read(p)
	}
}
func (r *Root) Manifest(ctx context.Context, maxBytes int64) (Manifest, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.manifest(ctx, maxBytes)
}
func (r *Root) manifest(ctx context.Context, maxBytes int64) (Manifest, error) {
	out := Manifest{Manifest: []Entry{}, Consistency: "best_effort", Exclusions: []string{}}
	if maxBytes <= 0 {
		maxBytes = 64 << 30
	}
	var total int64
	count := 0
	e := fs.WalkDir(r.root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == "." {
			return nil
		}
		count++
		if count > 100000 {
			return errors.New("manifest_entry_limit")
		}
		if e = SafePath(p); e != nil {
			out.Exclusions = append(out.Exclusions, p+":invalid_path")
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if isReparse(info) || !info.IsDir() && !info.Mode().IsRegular() {
			out.Exclusions = append(out.Exclusions, p+":symlink_reparse_or_special")
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		entry := Entry{Path: p, Kind: "directory", Mode: uint32(info.Mode().Perm())}
		if !info.IsDir() {
			if info.Size() > maxBytes-total {
				return errors.New("manifest_byte_limit")
			}
			f, e := openRead(r.root, p)
			if e != nil {
				return e
			}
			actual, e := f.Stat()
			if e != nil || !actual.Mode().IsRegular() {
				f.Close()
				return errors.New("regular_file_required")
			}
			h := sha256.New()
			n, e := io.Copy(h, io.LimitReader(contextReader{ctx, f}, maxBytes-total+1))
			after, se := f.Stat()
			ce := f.Close()
			if e != nil {
				return e
			}
			if se != nil {
				return se
			}
			if ce != nil {
				return ce
			}
			if n != actual.Size() || after.Size() != actual.Size() || !after.ModTime().Equal(actual.ModTime()) {
				return errors.New("file_conflict")
			}
			total += n
			if total > maxBytes {
				return errors.New("manifest_byte_limit")
			}
			hash := hex.EncodeToString(h.Sum(nil))
			entry.Kind = "file"
			entry.SizeBytes = n
			entry.SHA256 = &hash
		}
		out.Manifest = append(out.Manifest, entry)
		return nil
	})
	return out, e
}
func (r *Root) ReadRange(p string, offset, length int64) (FileRange, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := FileRange{Offset: offset}
	if offset < 0 || length < 0 || length > MaxRangeBytes {
		return out, errors.New("invalid_range")
	}
	if e := r.rejectLinks(p, false); e != nil {
		return out, e
	}
	f, e := openRead(r.root, p)
	if e != nil {
		return out, e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil || !info.Mode().IsRegular() {
		return out, errors.New("regular_file_required")
	}
	if offset > info.Size() {
		return out, errors.New("range_outside_file")
	}
	length = min(length, info.Size()-offset)
	data := make([]byte, int(length))
	if length > 0 {
		if _, e = f.ReadAt(data, offset); e != nil {
			return out, e
		}
	}
	after, e := f.Stat()
	if e != nil {
		return out, e
	}
	if info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return out, errors.New("file_conflict")
	}
	out.Content = data
	out.SHA256 = Hash(data)
	out.TotalBytes = info.Size()
	out.ModifiedAt = info.ModTime().UTC().Format(time.RFC3339Nano)
	return out, nil
}
func (r *Root) usage(exclude string) (int64, error) {
	var total int64
	count := 0
	e := fs.WalkDir(r.root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		count++
		if count > 100000 {
			return errors.New("workspace_entry_limit")
		}
		if p == "." {
			return nil
		}
		if e = SafePath(p); e != nil {
			return errors.New("quota_scan_incomplete")
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if isReparse(info) || !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("quota_scan_incomplete")
		}
		if info.Mode().IsRegular() && p != exclude {
			if info.Size() < 0 || info.Size() > (1<<62)-total {
				return errors.New("workspace_quota_exceeded")
			}
			total += info.Size()
		}
		return nil
	})
	return total, e
}
func (r *Root) Usage() (int64, error) { r.mu.Lock(); defer r.mu.Unlock(); return r.usage("") }

// PublishStream writes a private temporary inode through rooted handles, checks
// the complete staged digest and current destination version, then publishes it.
func (r *Root) PublishStream(ctx context.Context, p string, source io.Reader, size int64, wanted string, expected *string, quota int64) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.publishStream(ctx, p, source, size, wanted, expected, quota)
}
func (r *Root) publishStream(ctx context.Context, p string, source io.Reader, size int64, wanted string, expected *string, quota int64) (hash string, resultErr error) {
	if size < 0 || quota <= 0 || size > quota {
		return "", errors.New("workspace_quota_exceeded")
	}
	if e := r.rejectLinks(p, true); e != nil {
		return "", e
	}
	used, e := r.usage(p)
	if e != nil {
		return "", e
	}
	if size > quota-used {
		return "", errors.New("workspace_quota_exceeded")
	}
	parent, e := r.root.OpenRoot(path.Dir(p))
	if e != nil {
		return "", e
	}
	defer parent.Close()
	base := path.Base(p)
	check := func() error {
		info, e := parent.Lstat(base)
		if errors.Is(e, fs.ErrNotExist) {
			if expected != nil {
				return errors.New("file_conflict")
			}
			return nil
		}
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() || isReparse(info) {
			return errors.New("regular_file_required")
		}
		if expected == nil {
			return errors.New("file_conflict")
		}
		f, e := openRead(parent, base)
		if e != nil {
			return e
		}
		defer f.Close()
		h := sha256.New()
		_, e = io.Copy(h, contextReader{ctx, f})
		if e != nil {
			return e
		}
		if hex.EncodeToString(h.Sum(nil)) != *expected {
			return errors.New("file_conflict")
		}
		return nil
	}
	if e = check(); e != nil {
		return "", e
	}
	var nonce [16]byte
	if _, e = rand.Read(nonce[:]); e != nil {
		return "", e
	}
	tmp := fmt.Sprintf(".homelab-upload-%x", nonce)
	f, e := parent.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return "", e
	}
	defer parent.Remove(tmp)
	h := sha256.New()
	n, e := io.Copy(io.MultiWriter(f, h), io.LimitReader(contextReader{ctx, source}, size+1))
	if e == nil && n != size {
		e = errors.New("upload_size_mismatch")
	}
	digest := hex.EncodeToString(h.Sum(nil))
	if e == nil && digest != wanted {
		e = errors.New("upload_hash_mismatch")
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return "", e
	}
	if e = check(); e != nil {
		return "", e
	}
	if expected == nil {
		e = parent.Link(tmp, base)
	} else {
		e = parent.Rename(tmp, base)
	}
	if e != nil {
		return "", e
	}
	return digest, nil
}

func (m Manifest) Hash() string {
	s := Snapshot{Files: make([]SnapshotFile, 0, len(m.Manifest))}
	for _, entry := range m.Manifest {
		s.Files = append(s.Files, SnapshotFile{Entry: entry})
	}
	return ManifestHash(s)
}
