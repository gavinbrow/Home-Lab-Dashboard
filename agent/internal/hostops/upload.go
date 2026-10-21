package hostops

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"homelab/agent/internal/files"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const UploadChunkBytes = 1 << 20
const DefaultMaxUploadBytes int64 = 1 << 30
const DefaultMaxStagedBytes int64 = 2 << 30

type UploadRange struct {
	Offset int64  `json:"offset"`
	Length int64  `json:"length"`
	SHA256 string `json:"sha256"`
}
type Upload struct {
	CreatedAt       string        `json:"created_at"`
	UpdatedAt       string        `json:"updated_at"`
	ExpiresAt       string        `json:"expires_at,omitempty"`
	UploadID        string        `json:"upload_id"`
	WorkspaceID     string        `json:"workspace_id"`
	Path            string        `json:"path"`
	TotalBytes      int64         `json:"total_bytes"`
	SHA256          string        `json:"sha256"`
	ExpectedSHA256  *string       `json:"expected_sha256"`
	State           string        `json:"state"`
	BindingRevision int           `json:"binding_revision"`
	BindingIdentity string        `json:"-"`
	ReceivedBytes   int64         `json:"received_bytes"`
	Ranges          []UploadRange `json:"ranges"`
	OperationID     string        `json:"operation_id,omitempty"`
}
type noEffectsError struct{ error }

func initUploads(db *sql.DB) error {
	for _, sql := range []string{`CREATE TABLE IF NOT EXISTS hostops_uploads(upload_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,path TEXT NOT NULL,total_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,expected_sha256 TEXT,state TEXT NOT NULL,binding_revision INTEGER NOT NULL,binding_identity TEXT NOT NULL,operation_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`, `CREATE INDEX IF NOT EXISTS hostops_upload_activity ON hostops_uploads(state,updated_at)`, `CREATE TABLE IF NOT EXISTS hostops_upload_chunks(upload_id TEXT NOT NULL,offset INTEGER NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(upload_id,offset))`} {
		if _, e := db.Exec(sql); e != nil {
			return e
		}
	}
	return nil
}
func bindingIdentity(b WorkspaceBinding) string {
	data, _ := json.Marshal(struct {
		RootID, Root  string
		Revision      int
		EnvironmentID *string
		Generation    *int
	}{b.ApprovedRootID, b.CanonicalRoot, b.Revision, b.EnvironmentID, b.EnvironmentGeneration})
	return files.Hash(data)
}
func validHash(hash string) bool {
	if len(hash) != 64 {
		return false
	}
	for _, c := range hash {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func (m *Manager) uploadRoot(workspaceID string) (*os.Root, error) {
	dir := filepath.Join(m.config.DataDir, "uploads", workspaceID)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	canonical, e := filepath.EvalSymlinks(dir)
	if e != nil || canonical != dir {
		return nil, errors.New("unsafe_upload_storage")
	}
	return os.OpenRoot(dir)
}
func (m *Manager) loadUpload(workspaceID, id string) (Upload, error) {
	var u Upload
	var expected sql.NullString
	e := m.db.QueryRow(`SELECT upload_id,workspace_id,path,total_bytes,sha256,expected_sha256,state,binding_revision,binding_identity,operation_id,created_at,updated_at FROM hostops_uploads WHERE upload_id=? AND workspace_id=?`, id, workspaceID).Scan(&u.UploadID, &u.WorkspaceID, &u.Path, &u.TotalBytes, &u.SHA256, &expected, &u.State, &u.BindingRevision, &u.BindingIdentity, &u.OperationID, &u.CreatedAt, &u.UpdatedAt)
	if e != nil {
		return u, e
	}
	if stamp, e := time.Parse(time.RFC3339Nano, u.UpdatedAt); e == nil && u.State == "uploading" {
		ttl := m.config.UploadTTLSeconds
		if ttl <= 0 {
			ttl = 86400
		}
		u.ExpiresAt = stamp.Add(time.Duration(ttl) * time.Second).UTC().Format(time.RFC3339Nano)
	}
	if expected.Valid {
		u.ExpectedSHA256 = &expected.String
	}
	u.Ranges = []UploadRange{}
	rows, e := m.db.Query(`SELECT offset,size,sha256 FROM hostops_upload_chunks WHERE upload_id=? ORDER BY offset`, id)
	if e != nil {
		return u, e
	}
	defer rows.Close()
	for rows.Next() {
		var part UploadRange
		if e = rows.Scan(&part.Offset, &part.Length, &part.SHA256); e != nil {
			return u, e
		}
		u.ReceivedBytes += part.Length
		u.Ranges = append(u.Ranges, part)
	}
	if u.State == "completed" {
		u.ReceivedBytes = u.TotalBytes
	}
	return u, rows.Err()
}
func (m *Manager) createUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var q struct {
		UploadID       string  `json:"upload_id"`
		Path           string  `json:"path"`
		TotalBytes     int64   `json:"total_bytes"`
		SHA256         string  `json:"sha256"`
		ExpectedSHA256 *string `json:"expected_sha256"`
	}
	if _, e := decode(w, r, &q); e != nil || !safeID.MatchString(q.UploadID) || files.SafePath(q.Path) != nil || q.Path == "." || q.TotalBytes < 0 || !validHash(q.SHA256) || q.ExpectedSHA256 != nil && !validHash(*q.ExpectedSHA256) {
		http.Error(w, "invalid_upload", 400)
		return
	}
	id := r.PathValue("id")
	m.mu.Lock()
	defer m.mu.Unlock()
	binding, e := m.binding(id)
	if e != nil || !binding.Writable || binding.State != "active" {
		http.Error(w, "workspace_denied", 403)
		return
	}
	max := m.config.MaxUploadBytes
	if max <= 0 {
		max = DefaultMaxUploadBytes
	}
	if q.TotalBytes > max || binding.QuotaBytes > 0 && q.TotalBytes > binding.QuotaBytes {
		http.Error(w, "upload_quota_exceeded", 413)
		return
	}
	m.pruneUploadsLocked(time.Now())
	old, e := m.loadUpload(id, q.UploadID)
	if e == nil {
		sameExpected := old.ExpectedSHA256 == nil && q.ExpectedSHA256 == nil || old.ExpectedSHA256 != nil && q.ExpectedSHA256 != nil && *old.ExpectedSHA256 == *q.ExpectedSHA256
		if old.Path != q.Path || old.TotalBytes != q.TotalBytes || old.SHA256 != q.SHA256 || !sameExpected {
			http.Error(w, "upload_id_reused", 409)
			return
		}
		write(w, old)
		return
	}
	if !errors.Is(e, sql.ErrNoRows) {
		http.Error(w, "upload_journal_unavailable", 500)
		return
	}
	var otherOwner string
	if e = m.db.QueryRow(`SELECT workspace_id FROM hostops_uploads WHERE upload_id=?`, q.UploadID).Scan(&otherOwner); e == nil {
		http.Error(w, "upload_id_reused", 409)
		return
	} else if !errors.Is(e, sql.ErrNoRows) {
		http.Error(w, "upload_journal_unavailable", 500)
		return
	}
	var count int
	var reserved int64
	if e = m.db.QueryRow(`SELECT COUNT(*),COALESCE(SUM(total_bytes+8192+length(CAST(path AS BLOB))+length(upload_id)+((total_bytes+1048575)/1048576)*256),0) FROM hostops_uploads WHERE state IN ('uploading','published','cancelling')`).Scan(&count, &reserved); e != nil {
		http.Error(w, "upload_journal_unavailable", 500)
		return
	}
	budget := m.config.MaxStagedBytes
	if budget <= 0 {
		budget = DefaultMaxStagedBytes
	}
	maxPending := m.config.MaxPendingUploads
	if maxPending <= 0 {
		maxPending = 100000
	}
	charge := q.TotalBytes + 8192 + int64(len(q.Path)+len(q.UploadID)) + ((q.TotalBytes+UploadChunkBytes-1)/UploadChunkBytes)*256
	if count >= maxPending || charge > budget-reserved {
		http.Error(w, "upload_staging_quota_exceeded", 429)
		return
	}
	root, e := m.uploadRoot(id)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	defer root.Close()
	if e = root.Mkdir(q.UploadID, 0700); e != nil {
		http.Error(w, "upload_stage_exists_without_journal", 409)
		return
	}
	stage, e := root.OpenRoot(q.UploadID)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	defer stage.Close()
	f, e := stage.OpenFile("content", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	e = f.Sync()
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, e = m.db.Exec(`INSERT INTO hostops_uploads(upload_id,workspace_id,path,total_bytes,sha256,expected_sha256,state,binding_revision,binding_identity,created_at,updated_at) VALUES(?,?,?,?,?,?,'uploading',?,?,?,?)`, q.UploadID, id, q.Path, q.TotalBytes, q.SHA256, q.ExpectedSHA256, binding.Revision, bindingIdentity(binding), now, now)
	if e != nil {
		http.Error(w, "upload_stage_unknown", 500)
		return
	}
	u, e := m.loadUpload(id, q.UploadID)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	write(w, u)
}
func (m *Manager) uploadStatus(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id, upload := r.PathValue("id"), r.PathValue("upload")
	if _, e := m.binding(id); e != nil {
		http.Error(w, "workspace_denied", 403)
		return
	}
	u, e := m.loadUpload(id, upload)
	if e != nil {
		http.Error(w, "upload_not_found", 404)
		return
	}
	write(w, u)
}
func (m *Manager) putUploadChunk(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	var q struct {
		Offset  int64  `json:"offset"`
		Content string `json:"content_base64"`
		SHA256  string `json:"sha256"`
	}
	if _, e := decode(w, r, &q); e != nil || q.Offset < 0 || len(q.Content) > base64.StdEncoding.EncodedLen(UploadChunkBytes) || !validHash(q.SHA256) {
		http.Error(w, "invalid_upload_chunk", 400)
		return
	}
	bytes, e := base64.StdEncoding.DecodeString(q.Content)
	if e != nil || len(bytes) == 0 || len(bytes) > UploadChunkBytes || files.Hash(bytes) != q.SHA256 {
		http.Error(w, "upload_chunk_hash_mismatch", 400)
		return
	}
	id, upload := r.PathValue("id"), r.PathValue("upload")
	m.mu.Lock()
	defer m.mu.Unlock()
	if e = m.activeWritable(id); e != nil {
		http.Error(w, e.Error(), 403)
		return
	}
	u, e := m.loadUpload(id, upload)
	if e != nil {
		http.Error(w, "upload_not_found", 404)
		return
	}
	if u.State != "uploading" || q.Offset > u.TotalBytes-int64(len(bytes)) || q.Offset%UploadChunkBytes != 0 || int64(len(bytes)) != min(int64(UploadChunkBytes), u.TotalBytes-q.Offset) {
		http.Error(w, "upload_chunk_outside_file", 409)
		return
	}
	for _, part := range u.Ranges {
		if part.Offset == q.Offset && part.Length == int64(len(bytes)) && part.SHA256 == q.SHA256 {
			_, _ = m.db.Exec(`UPDATE hostops_uploads SET updated_at=? WHERE upload_id=?`, time.Now().UTC().Format(time.RFC3339Nano), upload)
			write(w, u)
			return
		}
		if part.Offset < q.Offset+int64(len(bytes)) && part.Offset+part.Length > q.Offset {
			http.Error(w, "upload_chunk_overlap", 409)
			return
		}
	}
	root, e := m.uploadRoot(id)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	defer root.Close()
	stage, e := root.OpenRoot(upload)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	defer stage.Close()
	info, e := stage.Lstat("content")
	if e != nil || !info.Mode().IsRegular() {
		http.Error(w, "upload_stage_invalid", 409)
		return
	}
	f, e := stage.OpenFile("content", os.O_WRONLY, 0600)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	_, e = f.WriteAt(bytes, q.Offset)
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	_, e = m.db.Exec(`INSERT INTO hostops_upload_chunks VALUES(?,?,?,?)`, upload, q.Offset, len(bytes), q.SHA256)
	if e != nil {
		http.Error(w, "upload_chunk_receipt_unknown", 500)
		return
	}
	_, _ = m.db.Exec(`UPDATE hostops_uploads SET updated_at=? WHERE upload_id=?`, time.Now().UTC().Format(time.RFC3339Nano), upload)
	u, e = m.loadUpload(id, upload)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	write(w, u)
}
func (m *Manager) completeUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	var q struct {
		OperationID string `json:"operation_id"`
	}
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	id, upload := r.PathValue("id"), r.PathValue("upload")
	receipt := m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		u, e := m.loadUpload(id, upload)
		if e != nil {
			return nil, noEffectsError{errors.New("upload_not_found")}
		}
		if u.State != "uploading" {
			return nil, noEffectsError{errors.New("upload_not_pending")}
		}
		var offset int64
		for _, part := range u.Ranges {
			if part.Offset != offset {
				return nil, noEffectsError{errors.New("upload_ranges_incomplete")}
			}
			offset += part.Length
		}
		if offset != u.TotalBytes {
			return nil, noEffectsError{errors.New("upload_ranges_incomplete")}
		}
		published := false
		var hash string
		e = m.guard(id, func() error {
			binding, x := m.binding(id)
			if x != nil || !binding.Writable || binding.State != "active" {
				return errors.New("workspace_denied")
			}
			if bindingIdentity(binding) != u.BindingIdentity {
				return errors.New("upload_workspace_identity_conflict")
			}
			root, x := m.uploadRoot(id)
			if x != nil {
				return x
			}
			defer root.Close()
			stage, x := root.OpenRoot(upload)
			if x != nil {
				return x
			}
			defer stage.Close()
			info, x := stage.Lstat("content")
			if x != nil || !info.Mode().IsRegular() || info.Size() != u.TotalBytes {
				return errors.New("upload_stage_invalid")
			}
			f, x := stage.Open("content")
			if x != nil {
				return x
			}
			defer f.Close()
			quota := binding.QuotaBytes
			if quota <= 0 {
				quota = DefaultMaxUploadBytes
			}
			hash, x = m.roots[id].PublishStream(r.Context(), u.Path, f, u.TotalBytes, u.SHA256, u.ExpectedSHA256, quota)
			if x != nil {
				return x
			}
			published = true
			_, x = m.db.Exec(`UPDATE hostops_uploads SET state='published',operation_id=?,updated_at=? WHERE upload_id=?`, q.OperationID, time.Now().UTC().Format(time.RFC3339Nano), upload)
			return x
		})
		if e != nil && !published {
			e = noEffectsError{e}
		}
		return map[string]any{"upload_id": upload, "sha256": hash, "size_bytes": u.TotalBytes}, e
	})
	if receipt.State == "completed" {
		m.mu.Lock()
		cleanupErr := m.cleanupPublishedUpload(id, upload, q.OperationID)
		m.mu.Unlock()
		if cleanupErr != nil {
			if result, ok := receipt.Result.(map[string]any); ok {
				result["staging_cleanup_pending"] = true
			}
		}
	}
	write(w, receipt)
}
func (m *Manager) cancelUpload(w http.ResponseWriter, r *http.Request) {
	id, upload := r.PathValue("id"), r.PathValue("upload")
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, e := m.binding(id); e != nil {
		http.Error(w, "workspace_denied", 403)
		return
	}
	u, e := m.loadUpload(id, upload)
	if e != nil {
		http.Error(w, "upload_not_found", 404)
		return
	}
	if u.State == "completed" || u.State == "published" {
		http.Error(w, "completed_upload_cannot_be_cancelled", 409)
		return
	}
	if u.State == "cancelled" {
		write(w, map[string]any{"upload_id": upload, "state": "cancelled", "project_files_preserved": true})
		return
	}
	if _, e = m.db.Exec(`UPDATE hostops_uploads SET state='cancelling',updated_at=? WHERE upload_id=?`, time.Now().UTC().Format(time.RFC3339Nano), upload); e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	root, e := m.uploadRoot(id)
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	defer root.Close()
	stage, e := root.OpenRoot(upload)
	if e == nil {
		e = stage.Remove("content")
		_ = stage.Close()
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			http.Error(w, "cancelled_upload_cleanup_pending", 500)
			return
		}
		e = root.Remove(upload)
	}
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		http.Error(w, "cancelled_upload_cleanup_pending", 500)
		return
	}
	if _, e = m.db.Exec(`UPDATE hostops_uploads SET state='cancelled',updated_at=? WHERE upload_id=?`, time.Now().UTC().Format(time.RFC3339Nano), upload); e != nil {
		http.Error(w, "upload_cancel_receipt_unknown", 500)
		return
	}
	_, _ = m.db.Exec(`DELETE FROM hostops_upload_chunks WHERE upload_id=?`, upload)
	write(w, map[string]any{"upload_id": upload, "state": "cancelled", "project_files_preserved": true})
}

// Cleanup is allowed only after the publication receipt is durable. Unknown
// outcomes retain and account their staged bytes for reviewed recovery.
func (m *Manager) cleanupPublishedUpload(workspace, id, operation string) error {
	u, e := m.loadUpload(workspace, id)
	if e != nil {
		return e
	}
	if u.State == "completed" {
		return nil
	}
	if u.State != "published" || u.OperationID != operation {
		return errors.New("upload_publication_unverified")
	}
	var receiptState string
	if e = m.db.QueryRow(`SELECT state FROM hostops_receipts WHERE operation_id=?`, operation).Scan(&receiptState); e != nil || receiptState != "completed" {
		return errors.New("upload_publication_receipt_not_durable")
	}
	root, e := m.uploadRoot(workspace)
	if e != nil {
		return e
	}
	defer root.Close()
	stage, e := root.OpenRoot(id)
	if e == nil {
		e = stage.Remove("content")
		_ = stage.Close()
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
		e = root.Remove(id)
	}
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	tx, e := m.db.Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`UPDATE hostops_uploads SET state='completed',updated_at=? WHERE upload_id=?`, time.Now().UTC().Format(time.RFC3339Nano), id); e != nil {
		return e
	}
	if _, e = tx.Exec(`DELETE FROM hostops_upload_chunks WHERE upload_id=?`, id); e != nil {
		return e
	}
	return tx.Commit()
}

// Expiration deletes only our enumerated inactive staging inode, never project
// bytes. Any unresolved workspace file intent keeps all its staged recovery data.
func (m *Manager) pruneUploadsLocked(now time.Time) {
	ttl := m.config.UploadTTLSeconds
	if ttl <= 0 {
		ttl = 86400
	}
	rows, e := m.db.Query(`SELECT workspace_id,upload_id FROM hostops_uploads WHERE state='uploading' AND updated_at<? LIMIT 256`, now.Add(-time.Duration(ttl)*time.Second).UTC().Format(time.RFC3339Nano))
	if e != nil {
		return
	}
	type key struct{ workspace, id string }
	keys := []key{}
	for rows.Next() {
		var k key
		if rows.Scan(&k.workspace, &k.id) != nil {
			rows.Close()
			return
		}
		keys = append(keys, k)
	}
	if rows.Close() != nil {
		return
	}
	for _, k := range keys {
		u, e := m.loadUpload(k.workspace, k.id)
		if e != nil {
			continue
		}
		expires, e := time.Parse(time.RFC3339Nano, u.ExpiresAt)
		if e != nil || expires.After(now) {
			continue
		}
		if m.WorkspaceBusy(k.workspace) != nil {
			continue
		}
		if _, e = m.db.Exec(`UPDATE hostops_uploads SET state='cancelling',updated_at=? WHERE upload_id=? AND state='uploading'`, now.UTC().Format(time.RFC3339Nano), k.id); e != nil {
			continue
		}
		root, e := m.uploadRoot(k.workspace)
		if e != nil {
			continue
		}
		stage, e := root.OpenRoot(k.id)
		if e == nil {
			e = stage.Remove("content")
			_ = stage.Close()
			if e == nil || errors.Is(e, os.ErrNotExist) {
				e = root.Remove(k.id)
			}
		}
		_ = root.Close()
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			continue
		}
		tx, e := m.db.Begin()
		if e != nil {
			continue
		}
		if _, e = tx.Exec(`UPDATE hostops_uploads SET state='expired',updated_at=? WHERE upload_id=?`, now.UTC().Format(time.RFC3339Nano), k.id); e == nil {
			_, e = tx.Exec(`DELETE FROM hostops_upload_chunks WHERE upload_id=?`, k.id)
		}
		if e == nil {
			e = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		_ = tx.Rollback()
	}
}
