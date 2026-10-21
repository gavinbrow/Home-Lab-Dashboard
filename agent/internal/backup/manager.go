// Package backup exports only locally configured roots, encrypting before any
// bytes cross the RPC boundary. Recovery keys are never accepted from RPC callers.
package backup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"filippo.io/age"
	"github.com/shirou/gopsutil/v4/disk"
	"homelab/agent/internal/protocol"
)

type Root struct {
	ID       string `json:"id"`
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Required bool   `json:"required"`
	Quiesced bool   `json:"quiesced"`
	Role     string `json:"role"`
}
type Config struct {
	LiveSnapshots           map[string]func(context.Context, string, int64) error `json:"-"`
	Enabled                 bool                                                  `json:"enabled"`
	Recipient               string                                                `json:"recipient"`
	GrantIDs                []string                                              `json:"grant_ids"`
	PolicyRevision          int                                                   `json:"policy_revision"`
	StagingDir              string                                                `json:"staging_dir"`
	ConnectionConfigFile    string                                                `json:"connection_config_file"`
	AdditionalRoots         []Root                                                `json:"additional_roots"`
	ExternalWritersQuiesced bool                                                  `json:"external_writers_quiesced"`
	ChunkBytes              int64                                                 `json:"chunk_bytes"`
	MaxBundleBytes          int64                                                 `json:"max_bundle_bytes"`
	MaxStagingBytes         int64                                                 `json:"max_staging_bytes"`
	MaxRetainedCaptures     int                                                   `json:"max_retained_captures"`
	MaxFiles                int                                                   `json:"max_files"`
	MaxDurationSeconds      int                                                   `json:"max_duration_seconds"`
	MachineID               string                                                `json:"-"`
	BootID                  string                                                `json:"-"`
	Roots                   []Root                                                `json:"-"`
	ExcludePaths            []string                                              `json:"-"`
	Guard                   func(func() error) error                              `json:"-"`
	Inventory               func() ([]Root, []Component, error)                   `json:"-"`
	MissingComponents       []Component                                           `json:"-"`
}
type Component struct {
	WorkspaceID string `json:"workspace_id,omitempty"`
	Kind        string `json:"kind,omitempty"`
	ID          string `json:"id"`
	Role        string `json:"role"`
	State       string `json:"state"`
	Consistency string `json:"consistency"`
	Reason      string `json:"reason,omitempty"`
}
type Coverage struct {
	MetadataOmissions []string    `json:"metadata_omissions"`
	Complete          bool        `json:"complete"`
	Components        []Component `json:"components"`
	Exclusions        []string    `json:"exclusions"`
}
type Capture struct {
	ID             string   `json:"id"`
	OperationID    string   `json:"operation_id"`
	BackupSetID    string   `json:"backup_set_id"`
	MachineID      string   `json:"machine_id"`
	BootID         string   `json:"boot_id"`
	State          string   `json:"state"`
	CreatedAt      string   `json:"created_at"`
	CapturedAt     string   `json:"captured_at,omitempty"`
	SizeBytes      int64    `json:"size_bytes,omitempty"`
	SHA256         string   `json:"sha256,omitempty"`
	ChunkSizeBytes int64    `json:"chunk_size_bytes,omitempty"`
	ChunkCount     int64    `json:"chunk_count,omitempty"`
	Coverage       Coverage `json:"coverage"`
	Reason         string   `json:"reason,omitempty"`
	Acknowledged   bool     `json:"acknowledged"`
}
type Request struct {
	OperationID    string `json:"operation_id"`
	BackupSetID    string `json:"backup_set_id"`
	GrantID        string `json:"grant_id"`
	PolicyRevision int    `json:"policy_revision"`
}
type Manager struct {
	db        *sql.DB
	cfg       Config
	recipient *age.X25519Recipient
	mu        sync.Mutex
	active    string
	cancels   map[string]context.CancelFunc
}

var validID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func New(db *sql.DB, cfg Config) (*Manager, error) {
	if !cfg.Enabled {
		return nil, errors.New("encrypted_host_backup_unconfigured")
	}
	recipient, e := age.ParseX25519Recipient(cfg.Recipient)
	if e != nil {
		return nil, errors.New("invalid_pinned_backup_recipient")
	}
	if !filepath.IsAbs(cfg.StagingDir) || cfg.Guard == nil || cfg.MachineID == "" || len(cfg.GrantIDs) == 0 || cfg.PolicyRevision < 1 {
		return nil, errors.New("invalid_host_backup_policy")
	}
	if cfg.ChunkBytes == 0 {
		cfg.ChunkBytes = 4 << 20
	}
	if cfg.ChunkBytes < 64<<10 || cfg.ChunkBytes > 8<<20 {
		return nil, errors.New("invalid_backup_chunk_size")
	}
	if cfg.MaxBundleBytes == 0 {
		cfg.MaxBundleBytes = 4 << 30
	}
	if cfg.MaxBundleBytes < 1 || cfg.MaxBundleBytes > 1<<40 {
		return nil, errors.New("invalid_backup_quota")
	}
	if cfg.MaxStagingBytes == 0 {
		cfg.MaxStagingBytes = 8 * cfg.MaxBundleBytes
	}
	if cfg.MaxStagingBytes < 8*cfg.MaxBundleBytes {
		return nil, errors.New("backup_staging_quota_too_small")
	}
	if cfg.MaxRetainedCaptures == 0 {
		cfg.MaxRetainedCaptures = 4
	}
	if cfg.MaxRetainedCaptures < 1 || cfg.MaxRetainedCaptures > 1000 {
		return nil, errors.New("invalid_capture_retention_limit")
	}
	if cfg.MaxFiles == 0 {
		cfg.MaxFiles = 100000
	}
	if cfg.MaxFiles < 1 || cfg.MaxFiles > 10000000 {
		return nil, errors.New("invalid_backup_entry_limit")
	}
	if cfg.MaxDurationSeconds == 0 {
		cfg.MaxDurationSeconds = 14400
	}
	if cfg.MaxDurationSeconds < 1 || cfg.MaxDurationSeconds > 86400 {
		return nil, errors.New("invalid_backup_duration")
	}
	if e = privateDirectory(cfg.StagingDir, false); e != nil {
		return nil, e
	}
	canonical, e := filepath.EvalSymlinks(cfg.StagingDir)
	if e != nil || canonical != cfg.StagingDir {
		return nil, errors.New("backup_staging_must_be_canonical")
	}
	if e = validateRoots(cfg.Roots, cfg.StagingDir); e != nil {
		return nil, e
	}
	seen := map[string]bool{}
	for _, r := range cfg.Roots {
		if !validID.MatchString(r.ID) || seen[r.ID] || !filepath.IsAbs(r.Path) {
			return nil, errors.New("invalid_fixed_backup_root")
		}
		if r.Kind != "file" && r.Kind != "directory" && r.Kind != "sqlite" {
			return nil, errors.New("invalid_fixed_backup_root_kind")
		}
		seen[r.ID] = true
	}
	if _, e = db.Exec(`CREATE TABLE IF NOT EXISTS encrypted_host_captures(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request BLOB NOT NULL,result BLOB NOT NULL);`); e != nil {
		return nil, e
	}
	m := &Manager{db: db, cfg: cfg, recipient: recipient, cancels: map[string]context.CancelFunc{}}
	rows, e := db.Query(`SELECT id,result FROM encrypted_host_captures`)
	if e != nil {
		return nil, e
	}
	var interrupted []Capture
	for rows.Next() {
		var id string
		var b []byte
		if e = rows.Scan(&id, &b); e != nil {
			rows.Close()
			return nil, e
		}
		var capture Capture
		if e = json.Unmarshal(b, &capture); e != nil {
			rows.Close()
			return nil, e
		}
		if capture.State == "preparing" {
			capture.State = "interrupted"
			capture.Reason = "host_restarted_during_capture_no_replay"
			interrupted = append(interrupted, capture)
		}
	}
	rows.Close()
	for _, c := range interrupted {
		if e = m.save(c); e != nil {
			return nil, e
		}
	}
	return m, nil
}
func (m *Manager) save(c Capture) error {
	raw, e := json.Marshal(c)
	if e != nil {
		return e
	}
	_, e = m.db.Exec(`UPDATE encrypted_host_captures SET result=? WHERE id=?`, raw, c.ID)
	return e
}
func (m *Manager) Get(id string) (Capture, error) {
	var c Capture
	var raw []byte
	e := m.db.QueryRow(`SELECT result FROM encrypted_host_captures WHERE id=?`, id).Scan(&raw)
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(raw, &c)
	return c, e
}
func (m *Manager) Start(q Request) (Capture, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !validID.MatchString(q.OperationID) || !validID.MatchString(q.BackupSetID) || !slices.Contains(m.cfg.GrantIDs, q.GrantID) || q.PolicyRevision != m.cfg.PolicyRevision {
		return Capture{}, errors.New("host_backup_grant_denied")
	}
	raw, e := protocol.CanonicalJSON(q)
	if e != nil {
		return Capture{}, e
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	var old string
	e = m.db.QueryRow(`SELECT request_hash FROM encrypted_host_captures WHERE id=?`, q.OperationID).Scan(&old)
	if e == nil {
		if old != hash {
			return Capture{}, errors.New("backup_operation_conflict")
		}
		return m.Get(q.OperationID)
	}
	if e != sql.ErrNoRows {
		return Capture{}, e
	}
	if m.active != "" {
		return Capture{}, errors.New("host_backup_capture_busy")
	}
	if e = m.capacity(); e != nil {
		return Capture{}, e
	}
	c := Capture{ID: q.OperationID, OperationID: q.OperationID, BackupSetID: q.BackupSetID, MachineID: m.cfg.MachineID, BootID: m.cfg.BootID, State: "preparing", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Coverage: Coverage{Components: []Component{}, Exclusions: []string{}}}
	result, _ := json.Marshal(c)
	if _, e = m.db.Exec(`INSERT INTO encrypted_host_captures VALUES(?,?,?,?)`, c.ID, hash, raw, result); e != nil {
		return Capture{}, e
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(m.cfg.MaxDurationSeconds)*time.Second)
	m.cancels[c.ID] = cancel
	m.active = c.ID
	go m.run(ctx, c)
	return c, nil
}
func (m *Manager) run(ctx context.Context, c Capture) {
	err := m.cfg.Guard(func() error {
		if m.cfg.Inventory != nil {
			roots, missing, e := m.cfg.Inventory()
			if e != nil {
				return e
			}
			if e = validateRoots(roots, m.cfg.StagingDir); e != nil {
				return e
			}
			m.cfg.Roots = roots
			m.cfg.MissingComponents = missing
		}
		return m.capture(ctx, &c)
	})
	if err != nil {
		c.State = "failed"
		c.Reason = "host_capture_failed"
		if ctx.Err() != nil {
			c.State = "cancelled"
			c.Reason = "host_capture_cancelled_or_deadline"
		}
		_ = os.Remove(filepath.Join(m.cfg.StagingDir, c.ID+".age.partial"))
	}
	if e := m.save(c); e != nil {
		c.State = "interrupted"
	}
	m.mu.Lock()
	if cancel := m.cancels[c.ID]; cancel != nil {
		cancel()
		delete(m.cancels, c.ID)
	}
	m.active = ""
	m.mu.Unlock()
}
func (m *Manager) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/host-state/policy", func(w http.ResponseWriter, r *http.Request) {
		h := sha256.Sum256([]byte(m.cfg.Recipient))
		answer(w, 200, map[string]any{"enabled": true, "grant_id": m.cfg.GrantIDs[0], "policy_revision": m.cfg.PolicyRevision, "recipient_fingerprint": hex.EncodeToString(h[:]), "chunk_size_bytes": m.cfg.ChunkBytes})
	})
	mux.HandleFunc("POST /v1/host-state/captures", m.createHTTP)
	mux.HandleFunc("GET /v1/host-state/captures/{id}", m.statusHTTP)
	mux.HandleFunc("GET /v1/host-state/captures/{id}/chunks/{index}", m.chunkHTTP)
	mux.HandleFunc("POST /v1/host-state/captures/{id}/ack", m.ackHTTP)
	mux.HandleFunc("DELETE /v1/host-state/captures/{id}", m.cancelHTTP)
}

// Reject configuration overlaps that could turn project-controlled paths into
// privileged state or plaintext staging. ACL ownership remains an installation prerequisite.
func contained(parent, child string) bool {
	if runtime.GOOS == "windows" {
		parent = strings.ToLower(parent)
		child = strings.ToLower(child)
	}
	rel, e := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}
func validateRoots(roots []Root, staging string) error {
	for _, r := range roots {
		if r.Role != "project" {
			continue
		}
		if contained(r.Path, staging) || contained(staging, r.Path) {
			return errors.New("backup_staging_overlaps_project")
		}
		for _, p := range roots {
			if p.Role != "project" && (contained(r.Path, p.Path) || contained(p.Path, r.Path)) {
				return errors.New("backup_state_overlaps_project")
			}
		}
	}
	return nil
}
func (m *Manager) capacity() error {
	usage, e := disk.Usage(m.cfg.StagingDir)
	if e != nil || usage.Free < uint64(8*m.cfg.MaxBundleBytes) {
		return errors.New("backup_free_space_reservation_unavailable")
	}
	var used int64
	count := 0
	entries, e := os.ReadDir(m.cfg.StagingDir)
	if e != nil {
		return e
	}
	for _, entry := range entries {
		if entry.IsDir() {
			return errors.New("backup_stale_plaintext_requires_review")
		}
		info, e := entry.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return errors.New("unsafe_backup_staging_entry")
		}
		used += info.Size()
		count++
	}
	if count >= m.cfg.MaxRetainedCaptures || used > m.cfg.MaxStagingBytes-8*m.cfg.MaxBundleBytes {
		return errors.New("backup_staging_capacity_exhausted")
	}
	return nil
}
