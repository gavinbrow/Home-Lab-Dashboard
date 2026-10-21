package hostops

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"homelab/agent/internal/files"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const maxJournalBackupBytes = 32 << 20

func (m *Manager) journalBackup(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID string `json:"operation_id"`
	}
	if _, e := decode(w, r, &q); e != nil || !safeID.MatchString(q.OperationID) {
		http.Error(w, "invalid_request", 400)
		return
	}
	if m.config.WithJournalBackup == nil {
		http.Error(w, "journal_quiescence_guard_unavailable", 503)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.poisoned.Load() {
		http.Error(w, "hostops_journal_unknown", 409)
		return
	}
	for _, binding := range m.CurrentBindings() {
		if e := m.WorkspaceBusy(binding.WorkspaceID); e != nil {
			http.Error(w, e.Error(), 409)
			return
		}
	}
	var data []byte
	e := m.config.WithJournalBackup(func() error {
		dir := filepath.Join(m.config.DataDir, "journal-exports")
		if e := os.MkdirAll(dir, 0700); e != nil {
			return e
		}
		canonical, e := filepath.EvalSymlinks(dir)
		if e != nil || canonical != dir {
			return errors.New("unsafe_backup_directory")
		}
		var nonce [16]byte
		if _, e = rand.Read(nonce[:]); e != nil {
			return e
		}
		file := filepath.Join(dir, "journal-"+hex.EncodeToString(nonce[:])+".sqlite")
		defer os.Remove(file)
		// SQLite VACUUM INTO takes a consistent database snapshot including WAL state.
		// The destination is host-generated; it can never be supplied by an RPC caller.
		if _, e = m.db.Exec(`VACUUM INTO ?`, file); e != nil {
			return e
		}
		f, e := os.Open(file)
		if e != nil {
			return e
		}
		defer f.Close()
		data, e = io.ReadAll(io.LimitReader(f, maxJournalBackupBytes+1))
		if e != nil {
			return e
		}
		if len(data) > maxJournalBackupBytes {
			return errors.New("journal_backup_requires_chunk_transport")
		}
		return nil
	})
	if e != nil {
		http.Error(w, e.Error(), 409)
		return
	}
	write(w, Receipt{OperationID: q.OperationID, State: "completed", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Result: map[string]any{"machine_id": m.config.MachineID, "boot_id": m.config.BootID, "captured_at": time.Now().UTC(), "sqlite_bytes": data, "sha256": files.Hash(data), "consistency": "sqlite_vacuum_into", "coverage": map[string]any{"complete": false, "included": []string{"supervisor_sqlite_journal", "host_file_receipts", "binding_revisions", "recovery_resolution_audit"}, "excluded": []string{"project_bytes", "quarantine_bytes", "precheckpoint_bytes", "enrollment_private_key", "signed_rpc_spool", "agent_configuration", "identity_credentials"}}}})
}
