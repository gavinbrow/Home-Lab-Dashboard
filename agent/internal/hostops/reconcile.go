package hostops

import (
	"database/sql"
	"encoding/json"
	"errors"
	"homelab/agent/internal/files"
	"net/http"
	"slices"
	"strings"
	"time"
)

func (m *Manager) overlayResolution(r Receipt) Receipt {
	var resolution, manifest, reason, resolutionID string
	e := m.db.QueryRow(`SELECT resolution,manifest_hash,reason,resolution_id FROM hostops_resolutions WHERE operation_id=?`, r.OperationID).Scan(&resolution, &manifest, &reason, &resolutionID)
	if errors.Is(e, sql.ErrNoRows) {
		return r
	}
	if e != nil {
		r.State = "outcome_unknown"
		r.Reason = "resolution_journal_unavailable"
		return r
	}
	original := r
	r.State = "failed"
	r.Reason = "operator_accepted_partial_outcome"
	r.Error = r.Reason
	started := true
	r.EffectsStarted = &started
	r.Result = map[string]any{"resolution": resolution, "observed_manifest_hash": manifest, "reason": reason, "original": original, "resolution_id": resolutionID}
	return r
}
func (m *Manager) reconcile(w http.ResponseWriter, r *http.Request) {
	var q struct {
		ResolutionID         string `json:"resolution_id,omitempty"`
		ExpectedManifestHash string `json:"expected_manifest_hash"`
		GrantID              string `json:"grant_id"`
		PolicyRevision       int    `json:"policy_revision"`
		Resolution           string `json:"resolution"`
		Reason               string `json:"reason"`
	}
	if _, e := decode(w, r, &q); e != nil || q.Resolution != "accept_partial" || q.ResolutionID != "" && !safeID.MatchString(q.ResolutionID) || len(q.Reason) < 8 || len(q.Reason) > 4096 {
		http.Error(w, "invalid_reconciliation", 400)
		return
	}
	id, operation := r.PathValue("id"), r.PathValue("operation")
	b, e := m.binding(id)
	if e != nil || b.RecoveryGrantID == "" || b.PolicyRevision < 1 || q.GrantID != b.RecoveryGrantID || q.GrantID == b.DeletionGrantID || slices.Contains(b.EnvironmentGrantIDs, q.GrantID) || q.PolicyRevision != b.PolicyRevision {
		http.Error(w, "protected_recovery_grant_required", 403)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var scope, raw, state string
	if e = m.db.QueryRow(`SELECT scope,receipt,state FROM hostops_receipts WHERE operation_id=?`, operation).Scan(&scope, &raw, &state); e != nil {
		http.Error(w, "operation_not_found", 404)
		return
	}
	prefix := "/v1/workspaces/" + id
	allowed := scope == prefix+"/files" || scope == prefix+"/restore" || scope == prefix+"/restore-stream" || scope == prefix+"/files/rename" || scope == prefix+"/directories" || strings.HasPrefix(scope, prefix+"/quarantine/") && strings.HasSuffix(scope, "/restore") || strings.HasPrefix(scope, prefix+"/uploads/") && strings.HasSuffix(scope, "/complete")
	if !allowed {
		http.Error(w, "file_operation_recovery_only", 403)
		return
	}
	var original Receipt
	if e = json.Unmarshal([]byte(raw), &original); e != nil {
		http.Error(w, "journal_corrupt", 500)
		return
	}
	overlaid := m.overlayResolution(original)
	if overlaid.Reason == "operator_accepted_partial_outcome" {
		write(w, overlaid)
		return
	}
	if state != "received" && state != "outcome_unknown" {
		http.Error(w, "operation_outcome_already_known", 409)
		return
	}
	e = m.guard(id, func() error {
		captured, e := m.roots[id].Manifest(r.Context(), b.QuotaBytes)
		if e != nil {
			return e
		}
		if len(captured.Exclusions) > 0 {
			return errors.New("recovery_capture_incomplete")
		}
		if captured.Hash() != q.ExpectedManifestHash {
			return errors.New("file_conflict")
		}
		_, e = m.db.Exec(`INSERT INTO hostops_resolutions VALUES(?,?,?,?,?,?,?,?,?,?)`, operation, id, raw, q.ExpectedManifestHash, q.GrantID, q.PolicyRevision, q.Resolution, q.Reason, time.Now().UTC().Format(time.RFC3339Nano), q.ResolutionID)
		return e
	})
	if e != nil {
		http.Error(w, e.Error(), 409)
		return
	}
	write(w, m.overlayResolution(original))
}

// WithStateBackup freezes hostops staging, lifecycle and receipt mutation before
// taking the supervisor barrier. Lock order matches normal file publications.
func (m *Manager) WithStateBackup(capture func() error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.config.WithJournalBackup == nil {
		return errors.New("journal_quiescence_guard_unavailable")
	}
	if m.poisoned.Load() {
		return errors.New("hostops_journal_unknown")
	}
	for _, binding := range m.CurrentBindings() {
		if e := m.WorkspaceBusy(binding.WorkspaceID); e != nil {
			return e
		}
	}
	return m.config.WithJournalBackup(capture)
}
func (m *Manager) recoveryManifest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	m.mu.Lock()
	defer m.mu.Unlock()
	binding, e := m.binding(id)
	if e != nil || binding.State == "unregistered" {
		http.Error(w, "workspace_denied", 403)
		return
	}
	var snapshot files.Manifest
	e = m.guard(id, func() error {
		var x error
		snapshot, x = m.roots[id].Manifest(r.Context(), binding.QuotaBytes)
		return x
	})
	if e != nil {
		http.Error(w, e.Error(), 409)
		return
	}
	write(w, map[string]any{"manifest": snapshot.Manifest, "manifest_hash": snapshot.Hash(), "consistency": snapshot.Consistency, "exclusions": snapshot.Exclusions, "binding": binding})
}
