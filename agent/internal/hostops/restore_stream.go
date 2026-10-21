package hostops

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"homelab/agent/internal/files"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const DefaultCheckpointBytes int64 = 4 << 30

func (m *Manager) checkpointBudget(incoming int64) error {
	dir := filepath.Join(m.config.DataDir, "precheckpoints")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	canonical, e := filepath.EvalSymlinks(dir)
	if e != nil || canonical != dir {
		return errors.New("unsafe_precheckpoint_directory")
	}
	root, e := files.Open(dir)
	if e != nil {
		return e
	}
	defer root.Close()
	used, e := root.Usage()
	if e != nil {
		return e
	}
	budget := m.config.MaxCheckpointBytes
	if budget <= 0 {
		budget = DefaultCheckpointBytes
	}
	if incoming < 0 || incoming > budget-used {
		return errors.New("precheckpoint_storage_quota_exceeded")
	}
	return nil
}
func (m *Manager) streamCheckpoint(workspace, operation string, manifest files.Manifest, open files.OpenStream) error {
	var total int64
	for _, entry := range manifest.Manifest {
		if entry.Kind == "file" {
			if entry.SizeBytes < 0 || entry.SizeBytes > (1<<62)-total {
				return errors.New("precheckpoint_size_invalid")
			}
			total += entry.SizeBytes
		}
	}
	if e := m.checkpointBudget(total); e != nil {
		return e
	}
	dir := filepath.Join(m.config.DataDir, "precheckpoints")
	root, e := os.OpenRoot(dir)
	if e != nil {
		return e
	}
	defer root.Close()
	id := workspace + "-" + operation
	if e = root.Mkdir(id, 0700); e != nil {
		return e
	}
	snapshot, e := root.OpenRoot(id)
	if e != nil {
		return e
	}
	defer snapshot.Close()
	if e = snapshot.Mkdir("data", 0700); e != nil {
		return e
	}
	data, e := snapshot.OpenRoot("data")
	if e != nil {
		return e
	}
	defer data.Close()
	type retained struct {
		Path   string `json:"path"`
		Blob   string `json:"blob"`
		Size   int64  `json:"size_bytes"`
		SHA256 string `json:"sha256"`
	}
	retainedFiles := []retained{}
	for _, entry := range manifest.Manifest {
		if entry.Kind != "file" {
			continue
		}
		if entry.SHA256 == nil {
			return errors.New("precheckpoint_hash_required")
		}
		name := fmt.Sprintf("%08d", len(retainedFiles))
		source, e := open(entry.Path)
		if e != nil {
			return e
		}
		destination, e := data.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			source.Close()
			return e
		}
		h := sha256.New()
		n, e := io.Copy(io.MultiWriter(destination, h), io.LimitReader(source, entry.SizeBytes+1))
		ce := source.Close()
		if e == nil {
			e = ce
		}
		if e == nil && (n != entry.SizeBytes || hex.EncodeToString(h.Sum(nil)) != *entry.SHA256) {
			e = errors.New("file_conflict")
		}
		if e == nil {
			e = destination.Sync()
		}
		ce = destination.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return e
		}
		retainedFiles = append(retainedFiles, retained{entry.Path, "data/" + name, n, *entry.SHA256})
	}
	metadata, e := json.Marshal(struct {
		SchemaVersion int            `json:"schema_version"`
		WorkspaceID   string         `json:"workspace_id"`
		OperationID   string         `json:"operation_id"`
		CapturedAt    string         `json:"captured_at"`
		Manifest      files.Manifest `json:"snapshot"`
		Files         []retained     `json:"retained_files"`
	}{1, workspace, operation, time.Now().UTC().Format(time.RFC3339Nano), manifest, retainedFiles})
	if e != nil {
		return e
	}
	if e = m.checkpointBudget(int64(len(metadata))); e != nil {
		return e
	}
	f, e := snapshot.OpenFile("manifest.json", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if _, e = f.Write(metadata); e != nil {
		return e
	}
	return f.Sync()
}
func uploadComplete(u Upload) bool {
	var offset int64
	for _, part := range u.Ranges {
		if part.Offset != offset {
			return false
		}
		offset += part.Length
	}
	return offset == u.TotalBytes
}
func (m *Manager) restoreStreams(w http.ResponseWriter, r *http.Request) {
	var q files.StreamRestoreRequest
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_restore_stream", 400)
		return
	}
	id := r.PathValue("id")
	if e = m.activeWritable(id); e != nil {
		http.Error(w, e.Error(), 403)
		return
	}
	receipt := m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		binding, e := m.binding(id)
		if e != nil {
			return nil, noEffectsError{e}
		}
		stages := map[string]Upload{}
		for _, file := range q.Files {
			if file.Entry.Kind != "file" {
				continue
			}
			if _, duplicate := stages[file.UploadID]; duplicate {
				return nil, noEffectsError{errors.New("duplicate_restore_upload")}
			}
			u, e := m.loadUpload(id, file.UploadID)
			if e != nil {
				return nil, noEffectsError{errors.New("restore_upload_missing")}
			}
			if u.State != "uploading" || !uploadComplete(u) || u.Path != file.Entry.Path || u.TotalBytes != file.Entry.SizeBytes || file.Entry.SHA256 == nil || u.SHA256 != *file.Entry.SHA256 || u.BindingIdentity != bindingIdentity(binding) {
				return nil, noEffectsError{errors.New("restore_upload_mismatch")}
			}
			stages[u.UploadID] = u
		}
		applied := false
		e = m.guard(id, func() error {
			current, e := m.binding(id)
			if e != nil || !current.Writable || current.State != "active" {
				return errors.New("workspace_denied")
			}
			if bindingIdentity(current) != bindingIdentity(binding) {
				return errors.New("file_conflict")
			}
			openStage := func(uploadID string) (io.ReadCloser, error) {
				u, ok := stages[uploadID]
				if !ok {
					return nil, errors.New("restore_upload_outside_plan")
				}
				root, e := m.uploadRoot(id)
				if e != nil {
					return nil, e
				}
				defer root.Close()
				stage, e := root.OpenRoot(uploadID)
				if e != nil {
					return nil, e
				}
				defer stage.Close()
				info, e := stage.Lstat("content")
				if e != nil || !info.Mode().IsRegular() || info.Size() != u.TotalBytes {
					return nil, errors.New("restore_upload_stage_invalid")
				}
				return stage.Open("content")
			}
			e = m.roots[id].RestoreStreams(r.Context(), q, openStage, func(manifest files.Manifest, open files.OpenStream) error {
				return m.streamCheckpoint(id, q.OperationID, manifest, open)
			}, current.QuotaBytes)
			if e != nil {
				if strings.HasPrefix(e.Error(), "restore_partial:") {
					applied = true
				}
				return e
			}
			applied = true
			tx, e := m.db.Begin()
			if e != nil {
				return e
			}
			defer tx.Rollback()
			for upload := range stages {
				if _, e = tx.Exec(`UPDATE hostops_uploads SET state='published',operation_id=?,updated_at=? WHERE upload_id=?`, q.OperationID, time.Now().UTC().Format(time.RFC3339Nano), upload); e != nil {
					return e
				}
			}
			return tx.Commit()
		})
		if e != nil && !applied {
			e = noEffectsError{e}
		}
		return map[string]any{"precheckpoint_id": id + "-" + q.OperationID, "restored_paths": len(q.Files), "deleted_paths": len(q.DeletePaths)}, e
	})
	if receipt.State == "completed" {
		m.mu.Lock()
		for _, file := range q.Files {
			if file.Entry.Kind == "file" {
				if e = m.cleanupPublishedUpload(id, file.UploadID, q.OperationID); e != nil {
					if result, ok := receipt.Result.(map[string]any); ok {
						result["staging_cleanup_pending"] = true
					}
				}
			}
		}
		m.mu.Unlock()
	}
	write(w, receipt)
}
