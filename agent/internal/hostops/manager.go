// Package hostops contains the protected host policy boundary for lifecycle RPCs.
package hostops

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"homelab/agent/internal/files"
	"homelab/agent/internal/protocol"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type WorkspaceBinding struct {
	RecoveryGrantID       string   `json:"-"`
	PolicyRevision        int      `json:"policy_revision"`
	State                 string   `json:"state"`
	WorkspaceID           string   `json:"workspace_id"`
	ApprovedRootID        string   `json:"approved_root_id"`
	CanonicalRoot         string   `json:"canonical_root"`
	RuntimePath           string   `json:"runtime_path"`
	Type                  string   `json:"type"`
	Writable              bool     `json:"writable"`
	QuotaBytes            int64    `json:"quota_bytes"`
	Revision              int      `json:"revision"`
	EnvironmentID         *string  `json:"environment_id"`
	EnvironmentGeneration *int     `json:"environment_generation"`
	ImageDigest           string   `json:"image_digest,omitempty"`
	RuntimeID             string   `json:"runtime_id,omitempty"`
	DeletionGrantID       string   `json:"-"`
	EnvironmentGrantIDs   []string `json:"-"`
	ContainerUser         string   `json:"container_user,omitempty"`
	CPUs                  float64  `json:"cpus,omitempty"`
	MemoryBytes           int64    `json:"memory_bytes,omitempty"`
	PidsLimit             int      `json:"pids_limit,omitempty"`
	Command               []string `json:"-"`
}
type Target struct {
	RuntimeID         string   `json:"runtime_id,omitempty"`
	ID                string   `json:"id"`
	Kind              string   `json:"kind"`
	Name              string   `json:"name,omitempty"`
	AllowedOperations []string `json:"allowed_operations"`
	GrantIDs          []string `json:"grant_ids,omitempty"`
	PolicyRevision    int      `json:"policy_revision"`
}
type Config struct {
	MachineIdentityGeneration string                       `json:"machine_identity_generation,omitempty"`
	MaxPendingUploads         int                          `json:"max_pending_uploads"`
	UploadTTLSeconds          int64                        `json:"upload_ttl_seconds"`
	MaxCheckpointBytes        int64                        `json:"max_checkpoint_bytes"`
	MaxUploadBytes            int64                        `json:"max_upload_bytes"`
	MaxStagedBytes            int64                        `json:"max_staged_bytes"`
	BootID                    string                       `json:"boot_id"`
	WevtutilPath              string                       `json:"wevtutil_path"`
	MachineID                 string                       `json:"machine_id"`
	DispatchEpoch             string                       `json:"dispatch_epoch"`
	DataDir                   string                       `json:"data_dir"`
	DockerPath                string                       `json:"docker_path"`
	SystemctlPath             string                       `json:"systemctl_path"`
	SCPath                    string                       `json:"sc_path"`
	JournalctlPath            string                       `json:"journalctl_path"`
	Workspaces                []WorkspaceBinding           `json:"workspaces"`
	Targets                   []Target                     `json:"targets"`
	OnEnvironmentChange       func(WorkspaceBinding) error `json:"-"`
	WithJournalBackup         func(func() error) error     `json:"-"`
}

type Manager struct {
	db       *sql.DB
	config   Config
	roots    map[string]*files.Root
	guard    func(string, func() error) error
	mu       sync.Mutex
	poisoned atomic.Bool
	bindings sync.Map
}
type Receipt struct {
	OperationID    string `json:"operation_id"`
	RequestHash    string `json:"request_hash,omitempty"`
	State          string `json:"state"`
	Result         any    `json:"result,omitempty"`
	Error          string `json:"error,omitempty"`
	ObservedAt     string `json:"observed_at"`
	Reason         string `json:"reason,omitempty"`
	EffectsStarted *bool  `json:"effects_started,omitempty"`
}

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func New(db *sql.DB, c Config, roots map[string]*files.Root, guard func(string, func() error) error) (*Manager, error) {
	if c.MaxPendingUploads < 0 || c.MaxPendingUploads > 100000 || c.MaxUploadBytes < 0 || c.MaxUploadBytes > DefaultMaxUploadBytes || c.MaxStagedBytes < 0 || c.MaxStagedBytes > 64<<30 || c.UploadTTLSeconds < 0 || c.UploadTTLSeconds != 0 && (c.UploadTTLSeconds < 60 || c.UploadTTLSeconds > 30*86400) {
		return nil, errors.New("upload_policy_invalid")
	}
	canonicalData, e := filepath.EvalSymlinks(c.DataDir)
	if e != nil {
		return nil, e
	}
	c.DataDir = canonicalData
	if db == nil || guard == nil || c.MachineID == "" || !filepath.IsAbs(c.DataDir) {
		return nil, errors.New("hostops_configuration_invalid")
	}
	seen := map[string]bool{}
	seenIDs := map[string]bool{}
	for i, w := range c.Workspaces {
		for j, v := range c.Workspaces {
			if i >= j {
				continue
			}
			rel, e := filepath.Rel(w.CanonicalRoot, v.CanonicalRoot)
			if e == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
				return nil, errors.New("overlapping_workspace_roots")
			}
			rel, e = filepath.Rel(v.CanonicalRoot, w.CanonicalRoot)
			if e == nil && (rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))) {
				return nil, errors.New("overlapping_workspace_roots")
			}
		}
	}
	for _, w := range c.Workspaces {
		canonical, e := filepath.EvalSymlinks(w.CanonicalRoot)
		if e != nil || !filepath.IsAbs(canonical) || canonical != w.CanonicalRoot || strings.HasPrefix(canonical, `\\`) || roots[w.WorkspaceID] == nil || !safeID.MatchString(w.WorkspaceID) || w.ApprovedRootID == "" {
			return nil, errors.New("workspace_binding_invalid")
		}
		key := canonical
		if filepath.Separator == '\\' {
			key = strings.ToLower(key)
		}
		if seen[key] || seenIDs[w.WorkspaceID] {
			return nil, errors.New("duplicate_workspace_root")
		}
		seen[key] = true
		seenIDs[w.WorkspaceID] = true
		rel, e := filepath.Rel(w.CanonicalRoot, c.DataDir)
		if e != nil || rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..") {
			return nil, errors.New("recovery_storage_inside_project")
		}
		if e = roots[w.WorkspaceID].SetRecoveryDirectory(filepath.Join(c.DataDir, "quarantine", w.WorkspaceID)); e != nil {
			return nil, e
		}
	}
	if _, e := db.Exec(`CREATE TABLE IF NOT EXISTS hostops_receipts(operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT NOT NULL, created_at TEXT NOT NULL,scope TEXT NOT NULL)`); e != nil {
		return nil, e
	}
	if _, e := db.Exec(`CREATE TABLE IF NOT EXISTS hostops_fences(operation_id TEXT PRIMARY KEY,fence INTEGER NOT NULL)`); e != nil {
		return nil, e
	}
	columns, e := db.Query(`PRAGMA table_info(hostops_receipts)`)
	if e != nil {
		return nil, e
	}
	hasScope := false
	for columns.Next() {
		var cid, notnull, pk int
		var name, typ string
		var defaultValue any
		if e = columns.Scan(&cid, &name, &typ, &notnull, &defaultValue, &pk); e != nil {
			columns.Close()
			return nil, e
		}
		if name == "scope" {
			hasScope = true
		}
	}
	if e = columns.Close(); e != nil {
		return nil, e
	}
	if !hasScope {
		if _, e = db.Exec(`ALTER TABLE hostops_receipts ADD COLUMN scope TEXT NOT NULL DEFAULT ''`); e != nil {
			return nil, e
		}
	}
	if _, e := db.Exec(`CREATE TABLE IF NOT EXISTS hostops_resolutions(operation_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,original_receipt TEXT NOT NULL,manifest_hash TEXT NOT NULL,grant_id TEXT NOT NULL,policy_revision INTEGER NOT NULL,resolution TEXT NOT NULL,reason TEXT NOT NULL,resolved_at TEXT NOT NULL,resolution_id TEXT NOT NULL DEFAULT '')`); e != nil {
		return nil, e
	}
	if e := ensureResolutionIDColumn(db); e != nil {
		return nil, e
	}
	if _, e := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS hostops_resolution_identity ON hostops_resolutions(resolution_id) WHERE resolution_id<>''`); e != nil {
		return nil, e
	}
	if e := initUploads(db); e != nil {
		return nil, e
	}
	m := &Manager{db: db, config: c, roots: roots, guard: guard}
	if _, e := db.Exec(`CREATE TABLE IF NOT EXISTS hostops_bindings(workspace_id TEXT PRIMARY KEY,binding TEXT NOT NULL)`); e != nil {
		return nil, e
	}
	for _, base := range c.Workspaces {
		if base.State == "" {
			base.State = "active"
		}
		var raw string
		e := db.QueryRow(`SELECT binding FROM hostops_bindings WHERE workspace_id=?`, base.WorkspaceID).Scan(&raw)
		if e == nil {
			var next WorkspaceBinding
			if e = json.Unmarshal([]byte(raw), &next); e != nil {
				return nil, e
			}
			if next.CanonicalRoot != base.CanonicalRoot || next.ApprovedRootID != base.ApprovedRootID {
				return nil, errors.New("persisted_binding_root_mismatch")
			}
			if next.Revision < base.Revision {
				m.bindings.Store(base.WorkspaceID, base)
				continue
			}
			base.Revision = next.Revision
			base.State = next.State
			base.EnvironmentID = next.EnvironmentID
			base.EnvironmentGeneration = next.EnvironmentGeneration
			base.RuntimeID = next.RuntimeID
		}
		m.bindings.Store(base.WorkspaceID, base)
	}
	return m, nil
}
func (m *Manager) binding(id string) (WorkspaceBinding, error) {
	if b, ok := m.bindings.Load(id); ok {
		return b.(WorkspaceBinding), nil
	}
	for _, w := range m.config.Workspaces {
		if w.WorkspaceID == id {
			return w, nil
		}
	}
	return WorkspaceBinding{}, errors.New("workspace_not_enrolled")
}
func (m *Manager) mutate(id, key string, body []byte, fn func() (any, error)) Receipt {
	return m.mutateChecked(id, key, body, nil, fn)
}
func (m *Manager) mutateChecked(id, key string, body []byte, preflight func() error, fn func() (any, error)) Receipt {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !safeID.MatchString(id) {
		return Receipt{State: "failed", Error: "invalid_operation_id"}
	}
	var semantic any
	if json.Unmarshal(body, &semantic) == nil {
		if object, ok := semantic.(map[string]any); ok {
			delete(object, "fence")
			delete(object, "dispatch_epoch")
			delete(object, "request_hash")
		}
		if canonical, e := protocol.CanonicalJSON(semantic); e == nil {
			body = canonical
		}
	}
	sum := sha256.Sum256(append([]byte(key+"\n"), body...))
	hash := hex.EncodeToString(sum[:])
	var oldHash, raw string
	e := m.db.QueryRow(`SELECT request_hash,receipt FROM hostops_receipts WHERE operation_id=?`, id).Scan(&oldHash, &raw)
	if e == nil {
		if oldHash != hash {
			return Receipt{OperationID: id, State: "conflict", Error: "operation_id_reused"}
		}
		var r Receipt
		_ = json.Unmarshal([]byte(raw), &r)
		r = m.overlayResolution(r)
		if r.State == "received" {
			r.State = "outcome_unknown"
			r.Error = "host_restart_during_mutation"
		}
		return r
	}
	if !errors.Is(e, sql.ErrNoRows) {
		return Receipt{OperationID: id, State: "failed", Error: "journal_unavailable"}
	}
	if preflight != nil {
		if e := preflight(); e != nil {
			return Receipt{OperationID: id, State: "failed", Reason: e.Error(), Error: e.Error()}
		}
	}
	if strings.HasPrefix(key, "/v1/workspaces/") {
		parts := strings.Split(key, "/")
		if len(parts) > 3 {
			if e := m.WorkspaceBusy(parts[3]); e != nil {
				return Receipt{OperationID: id, State: "failed", Error: e.Error()}
			}
		}
	}
	r := Receipt{OperationID: id, State: "received", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if preflight != nil {
		r.RequestHash = files.Hash(body)
	}
	initial, _ := json.Marshal(r)
	if _, e = m.db.Exec(`INSERT INTO hostops_receipts VALUES(?,?,?,?,?,?)`, id, hash, r.State, string(initial), time.Now().UTC().Format(time.RFC3339Nano), key); e != nil {
		return Receipt{OperationID: id, State: "failed", Error: "journal_unavailable"}
	}

	result, e := fn()
	r.Result = result
	r.State = "completed"
	if e != nil {
		r.State = "outcome_unknown"
		r.Error = e.Error()
		r.Reason = e.Error()
		var noEffects noEffectsError
		if errors.As(e, &noEffects) {
			r.State = "failed"
			f := false
			r.EffectsStarted = &f
		}
		if e.Error() == "file_conflict" {
			r.State = "conflict"
			f := false
			r.EffectsStarted = &f
		}
	}
	out, _ := json.Marshal(r)
	if _, e = m.db.Exec(`UPDATE hostops_receipts SET state=?,receipt=? WHERE operation_id=?`, r.State, string(out), id); e != nil {
		m.poisoned.Store(true)
		r.State = "outcome_unknown"
		r.Error = "receipt_persist_failed"
	}
	return r
}
func write(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, v any) ([]byte, error) {
	b, e := io.ReadAll(io.LimitReader(r.Body, 90<<20))
	if e != nil {
		return nil, e
	}
	if len(b) >= 90<<20 {
		return nil, errors.New("request_too_large")
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	if e = d.Decode(v); e != nil {
		return nil, e
	}
	if e = d.Decode(new(any)); e != io.EOF {
		return nil, errors.New("invalid_request")
	}
	return b, nil
}
func (m *Manager) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/workspaces", func(w http.ResponseWriter, r *http.Request) {
		write(w, map[string]any{"bindings": m.CurrentBindings()})
	})
	mux.HandleFunc("GET /v1/workspaces/{id}/recovery-manifest", m.recoveryManifest)
	mux.HandleFunc("GET /v1/workspaces/{id}/binding", func(w http.ResponseWriter, r *http.Request) {
		b, e := m.binding(r.PathValue("id"))
		if e != nil {
			http.Error(w, e.Error(), 404)
			return
		}
		write(w, b)
	})
	mux.HandleFunc("PUT /v1/workspaces/{id}/binding", m.transitionBinding)
	mux.HandleFunc("PUT /v1/workspaces/{id}/files", m.putFile)
	mux.HandleFunc("POST /v1/workspaces/{id}/files/rename", m.rename)
	mux.HandleFunc("POST /v1/workspaces/{id}/directories", m.mkdir)
	mux.HandleFunc("GET /v1/workspaces/{id}/quarantine", m.listQuarantine)
	mux.HandleFunc("POST /v1/workspaces/{id}/uploads", m.createUpload)
	mux.HandleFunc("GET /v1/workspaces/{id}/uploads/{upload}", m.uploadStatus)
	mux.HandleFunc("PUT /v1/workspaces/{id}/uploads/{upload}/chunks", m.putUploadChunk)
	mux.HandleFunc("POST /v1/workspaces/{id}/uploads/{upload}/complete", m.completeUpload)
	mux.HandleFunc("DELETE /v1/workspaces/{id}/uploads/{upload}", m.cancelUpload)
	mux.HandleFunc("POST /v1/workspaces/{id}/restore-stream", m.restoreStreams)
	mux.HandleFunc("POST /v1/workspaces/{id}/restore", m.restore)
	mux.HandleFunc("DELETE /v1/workspaces/{id}/files", m.quarantine)
	mux.HandleFunc("POST /v1/workspaces/{id}/quarantine/{qid}/restore", m.unquarantine)
	mux.HandleFunc("GET /v1/workspaces/{id}/file-operations/{operation}", m.receipt)
	mux.HandleFunc("POST /v1/workspaces/{id}/file-operations/{operation}/reconcile", m.reconcile)
	mux.HandleFunc("POST /v1/journal/backup", m.journalBackup)
	mux.HandleFunc("DELETE /v1/workspaces/{id}/data", m.deleteData)
	mux.HandleFunc("POST /v1/workspaces/{id}/environment/{verb}", m.environment)
	mux.HandleFunc("GET /v1/targets", func(w http.ResponseWriter, r *http.Request) {
		out := append([]Target{}, m.config.Targets...)
		for i := range out {
			out[i].Name = ""
			out[i].GrantIDs = nil
		}
		write(w, map[string]any{"targets": out})
	})
	mux.HandleFunc("POST /v1/targets/{id}/actions", m.action)
	mux.HandleFunc("POST /v1/targets/{id}/actions/{operation}/cancel", m.cancelAction)
	mux.HandleFunc("GET /v1/targets/{id}/actions/{operation}", func(w http.ResponseWriter, r *http.Request) {
		var raw string
		if e := m.db.QueryRow(`SELECT receipt FROM hostops_receipts WHERE operation_id=? AND scope=?`, r.PathValue("operation"), "/v1/targets/"+r.PathValue("id")+"/actions").Scan(&raw); e != nil {
			http.Error(w, "operation_not_found", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, raw)
	})
	mux.HandleFunc("POST /v1/backup", m.backup)
}
func (m *Manager) receipt(w http.ResponseWriter, r *http.Request) {
	var raw string
	if _, e := m.binding(r.PathValue("id")); e != nil {
		http.Error(w, "workspace_denied", 404)
		return
	}
	if e := m.db.QueryRow(`SELECT receipt FROM hostops_receipts WHERE operation_id=? AND substr(scope,1,?)=?`, r.PathValue("operation"), len("/v1/workspaces/"+r.PathValue("id")+"/"), "/v1/workspaces/"+r.PathValue("id")+"/").Scan(&raw); e != nil {
		http.Error(w, "operation_not_found", 404)
		return
	}
	var out Receipt
	if e := json.Unmarshal([]byte(raw), &out); e != nil {
		http.Error(w, "journal_corrupt", 500)
		return
	}
	out = m.overlayResolution(out)
	if out.State == "received" {
		out.State = "outcome_unknown"
		out.Reason = "mutation_not_reconciled"
	}
	write(w, out)
}
func (m *Manager) checkpoint(id, operation string, s files.Snapshot) error {
	dir := filepath.Join(m.config.DataDir, "precheckpoints")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	if e = m.checkpointBudget(int64(len(b))); e != nil {
		return e
	}
	f, e := os.OpenFile(filepath.Join(dir, id+"-"+operation+".json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	if _, e = f.Write(b); e != nil {
		return e
	}
	return f.Sync()
}
func (m *Manager) restore(w http.ResponseWriter, r *http.Request) {
	var q files.RestoreRequest
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	id := r.PathValue("id")
	b, e := m.binding(id)
	if e != nil || !b.Writable || b.State != "active" {
		http.Error(w, "workspace_denied", 403)
		return
	}
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		e := m.guard(id, func() error {
			current, x := m.binding(id)
			if x != nil || !current.Writable || current.State != "active" {
				return errors.New("workspace_denied")
			}
			return m.roots[id].RestoreWithQuota(q, func(s files.Snapshot) error { return m.checkpoint(id, q.OperationID, s) }, b.QuotaBytes)
		})
		return map[string]any{"precheckpoint_id": id + "-" + q.OperationID}, e
	}))
}
func (m *Manager) quarantine(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID    string `json:"operation_id"`
		Path           string `json:"path"`
		ExpectedSHA256 string `json:"expected_sha256"`
	}
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	id := r.PathValue("id")
	b, e := m.binding(id)
	if e != nil || !b.Writable || b.State != "active" {
		http.Error(w, "workspace_denied", 403)
		return
	}
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		var out files.Quarantine
		e := m.guard(id, func() error { var x error; out, x = m.roots[id].Quarantine(q.Path, q.ExpectedSHA256); return x })
		return out, e
	}))
}
func (m *Manager) unquarantine(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID string `json:"operation_id"`
	}
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	id := r.PathValue("id")
	b, e := m.binding(id)
	if e != nil || !b.Writable || b.State != "active" {
		http.Error(w, "workspace_denied", 403)
		return
	}
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		return nil, m.guard(id, func() error { return m.roots[id].RestoreQuarantine(r.PathValue("qid")) })
	}))
}

// WorkspaceBusy preserves host authority after the network or worker lease ends.
func (m *Manager) WorkspaceBusy(id string) error {
	if m.poisoned.Load() {
		return errors.New("hostops_journal_write_unknown")
	}

	var count int
	if e := m.db.QueryRow(`SELECT COUNT(*) FROM hostops_receipts r LEFT JOIN hostops_resolutions x ON x.operation_id=r.operation_id WHERE substr(r.scope,1,?)=? AND r.state IN ('received','outcome_unknown') AND x.operation_id IS NULL `, len("/v1/workspaces/"+id+"/"), "/v1/workspaces/"+id+"/").Scan(&count); e != nil {
		return e
	}
	if count > 0 {
		return errors.New("workspace_busy_unresolved_file_operation")
	}
	return nil
}

func (m *Manager) CurrentBindings() []WorkspaceBinding {
	out := make([]WorkspaceBinding, 0, len(m.config.Workspaces))
	for _, base := range m.config.Workspaces {
		b, _ := m.binding(base.WorkspaceID)
		out = append(out, b)
	}
	return out
}
func (m *Manager) saveBinding(b WorkspaceBinding) error {
	raw, e := json.Marshal(b)
	if e != nil {
		return e
	}
	if _, e = m.db.Exec(`INSERT INTO hostops_bindings(workspace_id,binding) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET binding=excluded.binding`, b.WorkspaceID, string(raw)); e != nil {
		return e
	}
	if m.config.OnEnvironmentChange != nil {
		if e = m.config.OnEnvironmentChange(b); e != nil {
			return e
		}
	}
	m.bindings.Store(b.WorkspaceID, b)
	return nil
}
func (m *Manager) transitionBinding(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID      string `json:"operation_id"`
		ExpectedRevision int    `json:"expected_revision"`
		State            string `json:"state"`
	}
	body, e := decode(w, r, &q)
	if e != nil || q.State != "active" && q.State != "archived" && q.State != "unregistered" {
		http.Error(w, "invalid_request", 400)
		return
	}
	id := r.PathValue("id")
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		var b WorkspaceBinding
		e := m.guard(id, func() error {
			var x error
			b, x = m.binding(id)
			if x != nil {
				return x
			}
			if b.Revision != q.ExpectedRevision {
				return errors.New("file_conflict")
			}
			b.Revision++
			b.State = q.State
			return m.saveBinding(b)
		})
		return map[string]any{"binding": b, "files_preserved": true}, e
	}))
}

func (m *Manager) cancelAction(w http.ResponseWriter, r *http.Request) {
	var raw string
	if e := m.db.QueryRow(`SELECT receipt FROM hostops_receipts WHERE operation_id=? AND scope=?`, r.PathValue("operation"), "/v1/targets/"+r.PathValue("id")+"/actions").Scan(&raw); e != nil {
		http.Error(w, "operation_not_found", 404)
		return
	}
	var out Receipt
	if e := json.Unmarshal([]byte(raw), &out); e != nil {
		http.Error(w, "journal_corrupt", 500)
		return
	}
	if out.State == "received" {
		out.State = "outcome_unknown"
		out.Reason = "inflight_helper_cannot_be_undone"
	}
	write(w, out)
}

func ensureResolutionIDColumn(db *sql.DB) error {
	rows, e := db.Query(`PRAGMA table_info(hostops_resolutions)`)
	if e != nil {
		return e
	}
	found := false
	for rows.Next() {
		var cid, required, pk int
		var name, kind string
		var initial any
		if e = rows.Scan(&cid, &name, &kind, &required, &initial, &pk); e != nil {
			rows.Close()
			return e
		}
		if name == "resolution_id" {
			found = true
		}
	}
	if e = rows.Close(); e != nil {
		return e
	}
	if found {
		return nil
	}
	_, e = db.Exec(`ALTER TABLE hostops_resolutions ADD COLUMN resolution_id TEXT NOT NULL DEFAULT ''`)
	return e
}
