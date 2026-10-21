// Package files keeps filesystem authority on the owning host. os.Root protects
// traversal during opens; it is not a sandbox for arbitrary native commands.
package files

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"sync"
	"time"
)

const MaxFileBytes = 16 << 20

type Entry struct {
	Path       string  `json:"path"`
	Kind       string  `json:"kind"`
	SHA256     *string `json:"sha256"`
	SizeBytes  int64   `json:"size_bytes"`
	Mode       uint32  `json:"mode"`
	ModifiedAt *string `json:"modified_at,omitempty"`
}
type SnapshotFile struct {
	Entry Entry  `json:"entry"`
	Bytes []byte `json:"bytes,omitempty"`
}
type Snapshot struct {
	Files       []SnapshotFile `json:"files"`
	Consistency string         `json:"consistency"`
	Exclusions  []string       `json:"exclusions"`
}
type Root struct {
	root             *os.Root
	recovery         *os.Root
	mu               sync.Mutex
	MaxSnapshotBytes int64
}

func Open(root string) (*Root, error) {
	r, e := os.OpenRoot(root)
	if e != nil {
		return nil, e
	}
	return &Root{root: r, MaxSnapshotBytes: 64 << 20}, nil
}
func (r *Root) Close() error {
	if r.recovery != nil {
		_ = r.recovery.Close()
	}
	return r.root.Close()
}
func SafePath(p string) error {
	if p == "." {
		return nil
	}
	if p == "" || strings.ContainsAny(p, "\\:\x00") || strings.HasPrefix(p, "/") || len(p) > 4096 {
		return errors.New("invalid_path")
	}
	for _, part := range strings.Split(p, "/") {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, " ") || strings.HasSuffix(part, ".") {
			return errors.New("invalid_path")
		}
		base := strings.ToUpper(strings.Split(part, ".")[0])
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || base == "CONIN$" || base == "CONOUT$" || (len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '0' && base[3] <= '9') {
			return errors.New("reserved_path")
		}
	}
	return nil
}
func Hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func (r *Root) rejectLinks(p string, allowMissing bool) error {
	if e := SafePath(p); e != nil {
		return e
	}
	if p == "." {
		return nil
	}
	parts := strings.Split(p, "/")
	for i := range parts {
		info, e := r.root.Lstat(strings.Join(parts[:i+1], "/"))
		if e != nil {
			if allowMissing && i == len(parts)-1 && errors.Is(e, fs.ErrNotExist) {
				return nil
			}
			return e
		}
		if isReparse(info) {
			return errors.New("symlink_or_reparse_denied")
		}
	}
	return nil
}
func (r *Root) read(p string) ([]byte, error) {
	if e := r.rejectLinks(p, false); e != nil {
		return nil, e
	}
	if e := SafePath(p); e != nil {
		return nil, e
	}
	info, e := r.root.Lstat(p)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("regular_file_required")
	}
	f, e := openRead(r.root, p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	info, e = f.Stat()
	if e != nil || !info.Mode().IsRegular() {
		return nil, errors.New("regular_file_required")
	}
	if info.Size() > MaxFileBytes {
		return nil, errors.New("file_too_large")
	}
	b, e := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
	if e != nil {
		return nil, e
	}
	if len(b) > MaxFileBytes {
		return nil, errors.New("file_too_large")
	}
	return b, nil
}
func (r *Root) Read(p string) ([]byte, error) { r.mu.Lock(); defer r.mu.Unlock(); return r.read(p) }
func (r *Root) List(p string) ([]Entry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := SafePath(p); e != nil {
		return nil, e
	}
	if e := r.rejectLinks(p, false); e != nil {
		return nil, e
	}
	f, e := r.root.Open(p)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	ds, e := f.ReadDir(1001)
	if e != nil && e != io.EOF {
		return nil, e
	}
	if len(ds) > 1000 {
		return nil, errors.New("listing_limit_exceeded")
	}
	out := []Entry{}
	for _, d := range ds {
		inf, e := d.Info()
		if e != nil {
			return nil, e
		}
		kind := "file"
		if d.IsDir() {
			kind = "directory"
		} else if d.Type()&os.ModeSymlink != 0 {
			kind = "symlink"
		} else if !inf.Mode().IsRegular() {
			kind = "special"
		}
		modified := inf.ModTime().UTC().Format(time.RFC3339Nano)
		out = append(out, Entry{Path: path.Join(p, d.Name()), Kind: kind, SizeBytes: inf.Size(), Mode: uint32(inf.Mode().Perm()), ModifiedAt: &modified})
	}
	return out, nil
}
func (r *Root) Write(p string, b []byte, expected *string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.write(p, b, expected)
}
func (r *Root) write(p string, b []byte, expected *string) (string, error) {
	if e := r.rejectLinks(p, true); e != nil {
		return "", e
	}
	if e := SafePath(p); e != nil {
		return "", e
	}
	if p == "." || len(b) > MaxFileBytes {
		return "", errors.New("file_too_large_or_invalid")
	}
	// The handle rooted parent survives an external parent-directory rename.
	parent, e := r.root.OpenRoot(path.Dir(p))
	if e != nil {
		return "", e
	}
	defer parent.Close()
	base := path.Base(p)
	check := func() error {
		inf, e := parent.Lstat(base)
		if errors.Is(e, fs.ErrNotExist) {
			if expected != nil {
				return errors.New("file_conflict")
			}
			return nil
		}
		if e != nil {
			return e
		}
		if !inf.Mode().IsRegular() {
			return errors.New("regular_file_required")
		}
		f, e := openRead(parent, base)
		if e != nil {
			return e
		}
		defer f.Close()
		data, e := io.ReadAll(io.LimitReader(f, MaxFileBytes+1))
		if e != nil {
			return e
		}
		if expected == nil || Hash(data) != *expected {
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
	if _, e = f.Write(b); e != nil {
		f.Close()
		return "", e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return "", e
	}
	if e = f.Close(); e != nil {
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
	return Hash(b), nil
}
func (r *Root) Capture() (Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.capture()
}
func (r *Root) capture() (Snapshot, error) {
	s := Snapshot{Files: []SnapshotFile{}, Consistency: "best_effort", Exclusions: []string{}}
	var total int64
	e := fs.WalkDir(r.root.FS(), ".", func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == "." {
			return nil
		}
		if len(s.Files) > 10000 {
			return errors.New("snapshot_entry_limit")
		}
		if e = SafePath(p); e != nil {
			s.Exclusions = append(s.Exclusions, p+": invalid_path")
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		inf, e := d.Info()
		if e != nil {
			return e
		}
		if isReparse(inf) {
			s.Exclusions = append(s.Exclusions, p+": symlink_or_reparse_denied")
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if !inf.Mode().IsRegular() && !d.IsDir() {
			s.Exclusions = append(s.Exclusions, p+": symlink_or_special")
			return nil
		}
		entry := Entry{Path: p, Kind: "directory", Mode: uint32(inf.Mode().Perm())}
		f := SnapshotFile{Entry: entry}
		if !d.IsDir() {
			b, e := r.read(p)
			if e != nil {
				s.Exclusions = append(s.Exclusions, p+": "+e.Error())
				return nil
			}
			total += int64(len(b))
			if total > r.MaxSnapshotBytes {
				return errors.New("snapshot_byte_limit")
			}
			h := Hash(b)
			f.Entry.Kind = "file"
			f.Entry.SHA256 = &h
			f.Entry.SizeBytes = int64(len(b))
			f.Bytes = b
		}
		s.Files = append(s.Files, f)
		return nil
	})
	return s, e
}
