package files

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"sort"
	"strings"
)

type StreamRestoreFile struct {
	Entry    Entry  `json:"entry"`
	UploadID string `json:"upload_id,omitempty"`
}
type StreamRestoreRequest struct {
	OperationID          string              `json:"operation_id"`
	ExpectedManifestHash string              `json:"expected_manifest_hash"`
	Files                []StreamRestoreFile `json:"files"`
	DeletePaths          []string            `json:"delete_paths"`
}
type OpenStream func(string) (io.ReadCloser, error)
type StreamCheckpoint func(Manifest, OpenStream) error

// RestoreStreams holds the rooted broker lock for validation, retained checkpoint,
// and publication. It never pretends unrelated native editors are frozen.
func (r *Root) RestoreStreams(ctx context.Context, q StreamRestoreRequest, openStage OpenStream, checkpoint StreamCheckpoint, quota int64) (resultErr error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	changed := false
	defer func() {
		if changed && resultErr != nil {
			resultErr = fmt.Errorf("restore_partial: %s", resultErr.Error())
		}
	}()
	if quota <= 0 {
		quota = DefaultStreamQuota
	}
	before, e := r.manifest(ctx, quota)
	if e != nil {
		return e
	}
	if len(before.Exclusions) > 0 {
		return errors.New("restore_capture_incomplete")
	}
	if before.Hash() != q.ExpectedManifestHash {
		return errors.New("file_conflict")
	}
	if checkpoint == nil || openStage == nil {
		return errors.New("restore_stream_sources_required")
	}
	if len(q.Files)+len(q.DeletePaths) > 100000 {
		return errors.New("restore_entry_limit")
	}
	old := map[string]Entry{}
	for _, entry := range before.Manifest {
		old[entry.Path] = entry
	}
	desired := map[string]StreamRestoreFile{}
	for _, f := range q.Files {
		p := f.Entry.Path
		if e = SafePath(p); e != nil {
			return e
		}
		if p == "." {
			return errors.New("invalid_restore_path")
		}
		if _, duplicate := desired[p]; duplicate {
			return errors.New("duplicate_restore_path")
		}
		if f.Entry.Mode&^uint32(0777) != 0 {
			return errors.New("restore_invalid_mode")
		}
		if f.Entry.Kind == "file" {
			if f.UploadID == "" || f.Entry.SHA256 == nil || f.Entry.SizeBytes < 0 {
				return errors.New("restore_staged_file_required")
			}
		} else if f.Entry.Kind == "directory" {
			if f.UploadID != "" || f.Entry.SHA256 != nil || f.Entry.SizeBytes != 0 {
				return errors.New("restore_directory_metadata_invalid")
			}
		} else {
			return errors.New("unsupported_restore_kind")
		}
		desired[p] = f
	}
	deletes := map[string]bool{}
	for _, p := range q.DeletePaths {
		if e = SafePath(p); e != nil {
			return e
		}
		if p == "." || deletes[p] {
			return errors.New("invalid_restore_delete")
		}
		previous, exists := old[p]
		if !exists {
			return errors.New("restore_delete_missing")
		}
		if want, both := desired[p]; both && want.Entry.Kind == previous.Kind {
			return errors.New("invalid_restore_delete_overlap")
		}
		deletes[p] = true
	}
	for p, want := range desired {
		if previous, exists := old[p]; exists && previous.Kind != want.Entry.Kind && !deletes[p] {
			return errors.New("file_conflict")
		}
	}
	for p := range deletes {
		if old[p].Kind == "directory" {
			for child := range old {
				if strings.HasPrefix(child, p+"/") && !deletes[child] {
					return errors.New("restore_delete_descendants_required")
				}
			}
		}
	}
	final := map[string]Entry{}
	for p, entry := range old {
		if !deletes[p] {
			final[p] = entry
		}
	}
	for p, want := range desired {
		final[p] = want.Entry
	}
	var total int64
	for _, entry := range final {
		if entry.Kind == "file" {
			if entry.SizeBytes > quota-total {
				return errors.New("workspace_quota_exceeded")
			}
			total += entry.SizeBytes
		}
	}
	expectedFinal := Manifest{Manifest: make([]Entry, 0, len(final))}
	for _, entry := range final {
		expectedFinal.Manifest = append(expectedFinal.Manifest, entry)
	}
	readBefore := func(p string) (io.ReadCloser, error) {
		if _, ok := old[p]; !ok {
			return nil, errors.New("checkpoint_path_outside_manifest")
		}
		if e := r.rejectLinks(p, false); e != nil {
			return nil, e
		}
		f, e := openRead(r.root, p)
		if e != nil {
			return nil, e
		}
		info, e := f.Stat()
		if e != nil || !info.Mode().IsRegular() {
			f.Close()
			return nil, errors.New("regular_file_required")
		}
		return f, nil
	}
	if e = checkpoint(before, readBefore); e != nil {
		return e
	}
	current, e := r.manifest(ctx, quota)
	if e != nil {
		return e
	}
	if len(current.Exclusions) > 0 || current.Hash() != q.ExpectedManifestHash {
		return errors.New("file_conflict")
	}
	deleteList := append([]string{}, q.DeletePaths...)
	sort.Slice(deleteList, func(i, j int) bool { return len(deleteList[i]) > len(deleteList[j]) })
	for _, p := range deleteList {
		if old[p].Kind == "file" {
			f, e := readBefore(p)
			if e != nil {
				return e
			}
			h := sha256.New()
			_, e = io.Copy(h, contextReader{ctx, f})
			ce := f.Close()
			if e != nil {
				return e
			}
			if ce != nil {
				return ce
			}
			if old[p].SHA256 == nil || hex.EncodeToString(h.Sum(nil)) != *old[p].SHA256 {
				return errors.New("file_conflict")
			}
		}
		changed = true
		if e = r.root.Remove(p); e != nil {
			return e
		}
		delete(old, p)
	}
	entries := append([]StreamRestoreFile{}, q.Files...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Entry.Path < entries[j].Entry.Path })
	for _, f := range entries {
		p := f.Entry.Path
		changed = true
		if f.Entry.Kind == "directory" {
			if e = r.rejectLinks(p, true); e != nil {
				return e
			}
			e = r.root.Mkdir(p, 0700)
			if errors.Is(e, fs.ErrExist) {
				info, x := r.root.Lstat(p)
				if x == nil && info.IsDir() {
					e = nil
				}
			}
			if e != nil {
				return e
			}
			continue
		}
		source, e := openStage(f.UploadID)
		if e != nil {
			return e
		}
		var expected *string
		if previous, exists := old[p]; exists {
			expected = previous.SHA256
		}
		_, e = r.publishStream(ctx, p, source, f.Entry.SizeBytes, *f.Entry.SHA256, expected, quota)
		ce := source.Close()
		if e != nil {
			return e
		}
		if ce != nil {
			return ce
		}
		if e = r.root.Chmod(p, fs.FileMode(f.Entry.Mode)); e != nil {
			return e
		}
	}
	for i := len(entries) - 1; i >= 0; i-- {
		f := entries[i]
		if f.Entry.Kind == "directory" {
			if e = r.root.Chmod(f.Entry.Path, fs.FileMode(f.Entry.Mode)); e != nil {
				return e
			}
		}
	}
	after, e := r.manifest(ctx, quota)
	if e != nil {
		return e
	}
	if len(after.Exclusions) > 0 || after.Hash() != expectedFinal.Hash() {
		return errors.New("restore_postcondition_conflict")
	}
	return nil
}

const DefaultStreamQuota int64 = 64 << 30
