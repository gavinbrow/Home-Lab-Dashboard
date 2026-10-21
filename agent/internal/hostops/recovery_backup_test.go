package hostops

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"homelab/agent/internal/files"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestExplicitPartialReconciliationPreservesOriginal(t *testing.T) {
	m, root := testManager(t)
	b, _ := m.binding("ws")
	b.RecoveryGrantID = "separate-recovery-grant"
	b.PolicyRevision = 3
	m.bindings.Store("ws", b)
	_ = m.mutate("partial", "/v1/workspaces/ws/restore", nil, func() (any, error) {
		return map[string]any{"precheckpoint_id": "before"}, errors.New("restore_partial: interrupted")
	})
	s, _ := root.Capture()
	mux := http.NewServeMux()
	m.Register(mux)
	call := func(hash, grant string) int {
		body, _ := json.Marshal(map[string]any{"expected_manifest_hash": hash, "grant_id": grant, "policy_revision": 3, "resolution": "accept_partial", "reason": "Reviewed current manifest and retained before checkpoint"})
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest("POST", "/v1/workspaces/ws/file-operations/partial/reconcile", bytes.NewReader(body)))
		return out.Code
	}
	if code := call(files.ManifestHash(s), "ordinary-file-grant"); code != 403 {
		t.Fatal(code)
	}
	if code := call("stale", b.RecoveryGrantID); code != 409 || m.WorkspaceBusy("ws") == nil {
		t.Fatal("stale reconciliation released lock", code)
	}
	oldGuard := m.guard
	m.guard = func(string, func() error) error { return errors.New("workspace_busy_unresolved_operation") }
	if code := call(files.ManifestHash(s), b.RecoveryGrantID); code != 409 {
		t.Fatal("unresolved command bypass", code)
	}
	m.guard = oldGuard
	if code := call(files.ManifestHash(s), b.RecoveryGrantID); code != 200 {
		t.Fatal(code)
	}
	if e := m.WorkspaceBusy("ws"); e != nil {
		t.Fatal(e)
	}
	var original string
	if e := m.db.QueryRow(`SELECT state FROM hostops_receipts WHERE operation_id='partial'`).Scan(&original); e != nil || original != "outcome_unknown" {
		t.Fatal("original receipt overwritten", original, e)
	}
	out := m.mutate("partial", "/v1/workspaces/ws/restore", nil, func() (any, error) { t.Fatal("replayed reconciled operation"); return nil, nil })
	if out.State != "failed" || out.Reason != "operator_accepted_partial_outcome" {
		t.Fatal(out)
	}
}
func TestConsistentSQLiteBackupWithWALAndCoverage(t *testing.T) {
	m, _ := testManager(t)
	m.config.WithJournalBackup = func(capture func() error) error { return capture() }
	if _, e := m.db.Exec(`PRAGMA journal_mode=WAL`); e != nil {
		t.Fatal(e)
	}
	if _, e := m.db.Exec(`CREATE TABLE backup_probe(value INTEGER)`); e != nil {
		t.Fatal(e)
	}
	if _, e := m.db.Exec(`INSERT INTO backup_probe VALUES(42)`); e != nil {
		t.Fatal(e)
	}
	mux := http.NewServeMux()
	m.Register(mux)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, httptest.NewRequest("POST", "/v1/journal/backup", bytes.NewBufferString(`{"operation_id":"backup-proof"}`)))
	if out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	var receipt struct {
		State  string `json:"state"`
		Result struct {
			Bytes       []byte `json:"sqlite_bytes"`
			Hash        string `json:"sha256"`
			Consistency string `json:"consistency"`
			Coverage    struct {
				Complete bool     `json:"complete"`
				Excluded []string `json:"excluded"`
			} `json:"coverage"`
		} `json:"result"`
	}
	if e := json.Unmarshal(out.Body.Bytes(), &receipt); e != nil {
		t.Fatal(e)
	}
	if receipt.State != "completed" || receipt.Result.Hash != files.Hash(receipt.Result.Bytes) || receipt.Result.Consistency != "sqlite_vacuum_into" || receipt.Result.Coverage.Complete || len(receipt.Result.Coverage.Excluded) < 5 {
		t.Fatal("backup metadata false", receipt.State, receipt.Result.Hash)
	}
	file := filepath.Join(t.TempDir(), "export.sqlite")
	if e := os.WriteFile(file, receipt.Result.Bytes, 0600); e != nil {
		t.Fatal(e)
	}
	restored, e := sql.Open("sqlite", file)
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	var value int
	if e = restored.QueryRow(`SELECT value FROM backup_probe`).Scan(&value); e != nil || value != 42 {
		t.Fatal("WAL row omitted", value, e)
	}
	var integrity string
	if e = restored.QueryRow(`PRAGMA quick_check`).Scan(&integrity); e != nil || integrity != "ok" {
		t.Fatal("invalid export", integrity, e)
	}
	var count int
	_ = m.db.QueryRow(`SELECT COUNT(*) FROM hostops_receipts`).Scan(&count)
	if count != 0 {
		t.Fatal("backup recursively persisted into journal")
	}
	_ = m.mutate("unknown", "/v1/workspaces/ws/files", nil, func() (any, error) { return nil, errors.New("unknown") })
	blocked := httptest.NewRecorder()
	mux.ServeHTTP(blocked, httptest.NewRequest("POST", "/v1/journal/backup", bytes.NewBufferString(`{"operation_id":"blocked"}`)))
	if blocked.Code != 409 {
		t.Fatal("backed up unresolved host", blocked.Code)
	}
}

func TestRecoveryManifestAndHostStateBarrier(t *testing.T) {
	m, root := testManager(t)
	_, _ = root.Write("current", []byte("reviewed"), nil)
	_ = m.mutate("unknown-file", "/v1/workspaces/ws/restore", nil, func() (any, error) { return nil, errors.New("restore_partial: unknown") })
	mux := http.NewServeMux()
	m.Register(mux)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, httptest.NewRequest("GET", "/v1/workspaces/ws/recovery-manifest", nil))
	if out.Code != 200 {
		t.Fatal("unknown file blocked safe recovery preview", out.Code, out.Body.String())
	}
	var preview struct {
		Manifest    []files.Entry `json:"manifest"`
		Hash        string        `json:"manifest_hash"`
		Consistency string        `json:"consistency"`
		Exclusions  []string      `json:"exclusions"`
	}
	if e := json.Unmarshal(out.Body.Bytes(), &preview); e != nil {
		t.Fatal(e)
	}
	if len(preview.Manifest) != 1 || preview.Hash == "" || len(preview.Exclusions) != 0 || preview.Consistency != "best_effort" {
		t.Fatal(preview)
	}
	called := false
	m.config.WithJournalBackup = func(fn func() error) error { called = true; return fn() }
	if e := m.WithStateBackup(func() error { return nil }); e == nil || called {
		t.Fatal("unknown file bypassed statebackup barrier")
	}
	b, _ := m.binding("ws")
	b.State = "unregistered"
	m.bindings.Store("ws", b)
	denied := httptest.NewRecorder()
	mux.ServeHTTP(denied, httptest.NewRequest("GET", "/v1/workspaces/ws/recovery-manifest", nil))
	if denied.Code != 403 {
		t.Fatal("unregistered root leaked recovery metadata", denied.Code)
	}
}
