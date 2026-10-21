package files

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ManifestHash agrees with the control plane canonical checkpoint manifest.
func ManifestHash(s Snapshot) string {
	type item struct {
		Kind string  `json:"kind"`
		Mode uint32  `json:"mode"`
		Path string  `json:"path"`
		SHA  *string `json:"sha256"`
		Size int64   `json:"size_bytes"`
	}
	a := make([]item, 0, len(s.Files))
	for _, f := range s.Files {
		x := item{Kind: f.Entry.Kind, Mode: f.Entry.Mode, Path: f.Entry.Path}
		if x.Kind == "file" {
			x.SHA = f.Entry.SHA256
			x.Size = f.Entry.SizeBytes
		}
		a = append(a, x)
	}
	sort.Slice(a, func(i, j int) bool { return a[i].Path < a[j].Path })
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(a)
	return Hash(bytes.TrimSuffix(b.Bytes(), []byte("\n")))
}

type RestoreRequest struct {
	OperationID          string         `json:"operation_id"`
	ExpectedManifestHash string         `json:"expected_manifest_hash"`
	Files                []SnapshotFile `json:"files"`
	DeletePaths          []string       `json:"delete_paths"`
}

// Restore serializes against every broker file writer. The caller must persist
// before in immutable storage before this function changes any project bytes.
// External native writers are not frozen; snapshots retain best_effort status.
func (r *Root) Restore(q RestoreRequest, checkpoint func(Snapshot) error) error {
	return r.RestoreWithQuota(q, checkpoint, r.MaxSnapshotBytes)
}
func (r *Root) RestoreWithQuota(q RestoreRequest, checkpoint func(Snapshot) error, quota int64) (resultErr error) {
	changed := false
	defer func() {
		if changed && resultErr != nil {
			resultErr = fmt.Errorf("restore_partial: %s", resultErr.Error())
		}
	}()
	r.mu.Lock()
	defer r.mu.Unlock()
	before, e := r.capture()
	if e != nil {
		return e
	}
	if len(before.Exclusions) > 0 {
		return errors.New("restore_capture_incomplete")
	}
	if ManifestHash(before) != q.ExpectedManifestHash {
		return errors.New("file_conflict")
	}
	if checkpoint == nil {
		return errors.New("precheckpoint_required")
	}
	if len(q.Files)+len(q.DeletePaths) > 10000 {
		return errors.New("restore_entry_limit")
	}
	old := map[string]SnapshotFile{}
	for _, f := range before.Files {
		old[f.Entry.Path] = f
	}
	desired := map[string]string{}
	for _, f := range q.Files {
		desired[f.Entry.Path] = f.Entry.Kind
	}
	deleteSet := map[string]bool{}
	for _, p := range q.DeletePaths {
		if deleteSet[p] {
			return errors.New("invalid_restore_delete")
		}
		deleteSet[p] = true
	}
	seen := map[string]bool{}
	var total int64
	for _, f := range q.Files {
		if e = SafePath(f.Entry.Path); e != nil {
			return e
		}
		if f.Entry.Path == "." || seen[f.Entry.Path] {
			return errors.New("invalid_restore_path")
		}
		seen[f.Entry.Path] = true
		if f.Entry.Mode&^uint32(0777) != 0 {
			return errors.New("restore_invalid_mode")
		}
		if f.Entry.Kind == "directory" && (f.Entry.SizeBytes != 0 || f.Entry.SHA256 != nil || len(f.Bytes) != 0) {
			return errors.New("restore_directory_metadata_invalid")
		}
		if f.Entry.Kind != "file" && f.Entry.Kind != "directory" {
			return errors.New("unsupported_restore_kind")
		}
		if f.Entry.Kind == "file" {
			total += int64(len(f.Bytes))
			if len(f.Bytes) > MaxFileBytes || f.Entry.SizeBytes != int64(len(f.Bytes)) || f.Entry.SHA256 == nil || *f.Entry.SHA256 != Hash(f.Bytes) {
				return errors.New("restore_content_mismatch")
			}
		}
	}
	if total > r.MaxSnapshotBytes {
		return errors.New("snapshot_byte_limit")
	}
	for _, p := range q.DeletePaths {
		if e = SafePath(p); e != nil {
			return e
		}
		if p == "." || seen[p] && (old[p].Entry.Kind == "" || old[p].Entry.Kind == desired[p]) {
			return errors.New("invalid_restore_delete")
		}
		seen[p] = true
	}
	for p, kind := range desired {
		if previous, ok := old[p]; ok && previous.Entry.Kind != kind && !deleteSet[p] {
			return errors.New("file_conflict")
		}
	}
	for p := range deleteSet {
		previous, ok := old[p]
		if !ok {
			return errors.New("restore_delete_missing")
		}
		if previous.Entry.Kind == "directory" {
			for child := range old {
				if strings.HasPrefix(child, p+"/") && !deleteSet[child] {
					return errors.New("restore_delete_descendants_required")
				}
			}
		}
	}
	if quota <= 0 {
		quota = r.MaxSnapshotBytes
	}
	var finalSize int64
	deletesSet := map[string]bool{}
	for _, p := range q.DeletePaths {
		deletesSet[p] = true
	}
	for _, f := range before.Files {
		if f.Entry.Kind == "file" && !seen[f.Entry.Path] && !deletesSet[f.Entry.Path] {
			finalSize += f.Entry.SizeBytes
		}
	}
	for _, f := range q.Files {
		if f.Entry.Kind == "file" {
			finalSize += f.Entry.SizeBytes
		}
	}
	if finalSize > quota {
		return errors.New("workspace_quota_exceeded")
	}
	if e = checkpoint(before); e != nil {
		return e
	}
	// Persisted precheckpoint permits recovery after interruption. Any error after
	// this point must be reported as outcome_unknown and never automatically replayed.
	current, e := r.capture()
	if e != nil {
		return e
	}
	if ManifestHash(current) != q.ExpectedManifestHash {
		return errors.New("file_conflict")
	}
	deletes := append([]string{}, q.DeletePaths...)
	sort.Slice(deletes, func(i, j int) bool { return len(deletes[i]) > len(deletes[j]) })
	changed = true
	for _, p := range deletes {
		if _, ok := old[p]; !ok {
			return errors.New("restore_delete_missing")
		}
		if e = r.root.Remove(p); e != nil {
			return e
		}
		delete(old, p)
	}
	entries := append([]SnapshotFile{}, q.Files...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Entry.Path < entries[j].Entry.Path })
	for _, f := range entries {
		p := f.Entry.Path
		if f.Entry.Kind == "directory" {
			if e = r.rejectLinks(p, true); e != nil {
				return e
			}
			e = r.root.Mkdir(p, 0700)
			if errors.Is(e, fs.ErrExist) {
				inf, x := r.root.Lstat(p)
				if x == nil && inf.IsDir() {
					e = nil
				}
			}
			if e != nil {
				return e
			}
			continue
		}
		var expected *string
		if prev, ok := old[p]; ok {
			expected = prev.Entry.SHA256
		}
		if _, e = r.write(p, f.Bytes, expected); e != nil {
			return e
		}
		if e = r.root.Chmod(p, fs.FileMode(f.Entry.Mode&0777)); e != nil {
			return e
		}
	}
	for i := len(entries) - 1; i >= 0; i-- {
		f := entries[i]
		if f.Entry.Kind == "directory" {
			if e = r.root.Chmod(f.Entry.Path, fs.FileMode(f.Entry.Mode&0777)); e != nil {
				return e
			}
		}
	}
	return nil
}

type Quarantine struct {
	Mode      uint32 `json:"mode"`
	CreatedAt string `json:"created_at"`
	ID        string `json:"id"`
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
}

// SetRecoveryDirectory selects host-owned storage outside project access. The
// service administrator must keep this directory private from execution users.
func (r *Root) SetRecoveryDirectory(dir string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !filepath.IsAbs(dir) {
		return errors.New("absolute_recovery_directory_required")
	}
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	canonical, e := filepath.EvalSymlinks(dir)
	if e != nil || canonical != dir {
		return errors.New("unsafe_recovery_directory")
	}
	s, e := os.Lstat(dir)
	if e != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return errors.New("unsafe_recovery_directory")
	}
	next, e := os.OpenRoot(dir)
	if e != nil {
		return e
	}
	if r.recovery != nil {
		_ = r.recovery.Close()
	}
	r.recovery = next
	return nil
}
func (r *Root) Quarantine(p, expected string) (Quarantine, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	q := Quarantine{}
	if r.recovery == nil {
		return q, errors.New("protected_recovery_storage_required")
	}
	b, e := r.read(p)
	if e != nil {
		return q, e
	}
	if expected == "" || Hash(b) != expected {
		return q, errors.New("file_conflict")
	}
	var nonce [16]byte
	if _, e = rand.Read(nonce[:]); e != nil {
		return q, e
	}
	info, e := r.root.Lstat(p)
	if e != nil {
		return q, e
	}
	q = Quarantine{ID: hex.EncodeToString(nonce[:]), Path: p, SHA256: expected, Mode: uint32(info.Mode().Perm()), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	save := func(name string, b []byte) error {
		f, e := r.recovery.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		defer f.Close()
		if _, e = f.Write(b); e != nil {
			return e
		}
		return f.Sync()
	}
	if e = save(q.ID+".data", b); e != nil {
		return q, e
	}
	meta, _ := json.Marshal(q)
	if e = save(q.ID+".json", meta); e != nil {
		return q, e
	}
	current, e := r.read(p)
	if e != nil {
		return q, e
	}
	if Hash(current) != expected {
		return q, errors.New("file_conflict")
	}
	if e = r.root.Remove(p); e != nil {
		return q, e
	}
	return q, nil
}
func (r *Root) RestoreQuarantine(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.recovery == nil {
		return errors.New("protected_recovery_storage_required")
	}
	if len(id) != 32 {
		return errors.New("invalid_quarantine_id")
	}
	if _, e := hex.DecodeString(id); e != nil {
		return errors.New("invalid_quarantine_id")
	}
	b, e := r.recovery.ReadFile(id + ".json")
	if e != nil {
		return e
	}
	var q Quarantine
	if e = json.Unmarshal(b, &q); e != nil {
		return e
	}
	if q.ID != id {
		return errors.New("quarantine_identity_mismatch")
	}
	if e = SafePath(q.Path); e != nil {
		return e
	}
	data, e := r.recovery.ReadFile(id + ".data")
	if e != nil {
		return e
	}
	if Hash(data) != q.SHA256 {
		return errors.New("quarantine_content_mismatch")
	}
	if _, e = r.write(q.Path, data, nil); e != nil {
		return e
	}
	if e = r.root.Chmod(q.Path, fs.FileMode(q.Mode&0777)); e != nil {
		return e
	}
	if e = r.recovery.Remove(id + ".data"); e != nil {
		return e
	}
	return r.recovery.Remove(id + ".json")
}

// WriteWithQuota checks cumulative bytes under the same mutex as publication.
func (r *Root) WriteWithQuota(p string, b []byte, expected *string, quota int64) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if quota <= 0 {
		quota = r.MaxSnapshotBytes
	}
	used, e := r.usage(p)
	if e != nil {
		return "", e
	}
	if int64(len(b)) > quota-used {
		return "", errors.New("workspace_quota_exceeded")
	}
	return r.write(p, b, expected)
}

func (r *Root) Mkdir(p string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := SafePath(p); e != nil {
		return e
	}
	if p == "." {
		return errors.New("directory_conflict")
	}
	if e := r.rejectLinks(p, true); e != nil {
		return e
	}
	return r.root.Mkdir(p, 0700)
}

// RenameFile publishes the destination without replacing an external file. A
// crash between link and unlink leaves both names and an unknown host receipt.
func (r *Root) RenameFile(source, destination, expected string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := SafePath(destination); e != nil {
		return e
	}
	if e := r.rejectLinks(destination, true); e != nil {
		return e
	}
	if destination == "." || source == destination {
		return errors.New("file_conflict")
	}
	b, e := r.read(source)
	if e != nil {
		return e
	}
	if Hash(b) != expected {
		return errors.New("file_conflict")
	}
	if e = r.root.Link(source, destination); e != nil {
		return e
	}
	if e = r.root.Remove(source); e != nil {
		return fmt.Errorf("rename_partial: %s", e.Error())
	}
	return nil
}
func (r *Root) ListQuarantine() ([]Quarantine, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.recovery == nil {
		return nil, errors.New("protected_recovery_storage_required")
	}
	f, e := r.recovery.Open(".")
	if e != nil {
		return nil, e
	}
	defer f.Close()
	entries, e := f.ReadDir(10001)
	if e != nil {
		return nil, e
	}
	if len(entries) > 10000 {
		return nil, errors.New("quarantine_listing_limit")
	}
	out := []Quarantine{}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".json") {
			b, e := r.recovery.ReadFile(entry.Name())
			if e != nil {
				return nil, e
			}
			var q Quarantine
			if e = json.Unmarshal(b, &q); e != nil {
				return nil, e
			}
			out = append(out, q)
		}
	}
	return out, nil
}
