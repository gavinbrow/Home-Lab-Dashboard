package supervisor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"homelab/agent/internal/protocol"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Service) WorkspaceReadable(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	w, ok := s.workspace(id)
	if !ok || w.State == "unregistered" {
		return errors.New("workspace_not_enrolled")
	}
	return nil
}
func (s *Service) Roots() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []map[string]any{}
	for _, w := range s.Config.Workspaces {
		if w.State == "unregistered" {
			continue
		}
		id := w.ApprovedRootID
		if id == "" {
			id = w.ID
		}
		kind := w.Type
		if kind == "" {
			kind = "native"
			if w.ContainerEnabled {
				kind = "container"
			}
		}
		runtimePath := w.RuntimePath
		if runtimePath == "" {
			runtimePath = w.Root
			if kind == "container" {
				runtimePath = "/workspace/project"
			}
		}
		items = append(items, map[string]any{"id": id, "approved_root_id": id, "workspace_id": w.ID, "canonical_root": w.Root, "runtime_path": runtimePath, "type": kind, "access": map[string]bool{"read": true, "write": w.Writable && (w.State == "" || w.State == "active")}})
	}
	return items
}
func (s *Service) Identities() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	items := []map[string]any{}
	seen := map[string]bool{}
	for _, w := range s.Config.Workspaces {
		if w.State != "" && w.State != "active" {
			continue
		}
		if w.ExecutionIdentityID == "" || seen[w.ExecutionIdentityID] {
			continue
		}
		seen[w.ExecutionIdentityID] = true
		verified := false
		identity := "unconfigured"
		kind := "native"
		network := []string{}
		reason := "runtime_not_enabled"
		if w.ContainerEnabled {
			kind = "container"
			identity = w.User
			network = []string{"deny", "runtime_default"}
			reason = "container_identity_probe_not_run"
			var proof struct {
				Verified   bool      `json:"verified"`
				ObservedAt time.Time `json:"observed_at"`
				User       string    `json:"user"`
				Image      string    `json:"image"`
				Root       string    `json:"root"`
			}
			raw, e := os.ReadFile(filepath.Join(s.Config.DataDir, "container-proof-"+w.ID+".json"))
			if e == nil && json.Unmarshal(raw, &proof) == nil && proof.Verified && proof.User == w.User && proof.Image == w.Image && proof.Root == w.Root && time.Since(proof.ObservedAt) < 5*time.Minute {
				verified = true
				reason = ""
			}
		} else if w.NativeEnabled {
			runner, e := s.nativeRunner(w)
			if e == nil {
				p, e := runner.ValidProof()
				if e == nil && p.Verified {
					verified = true
					identity = p.Identity
					reason = ""
				} else {
					reason = "identity_probe_not_run_or_stale"
				}
				network = []string{"runtime_default"}
				if w.Native != nil && w.Native.UID != 0 {
					network = append(network, "deny")
					identity = fmt.Sprintf("%d:%d", w.Native.UID, w.Native.GID)
				} else if w.Native != nil {
					identity = w.Native.ExpectedSID
				}
			} else {
				reason = e.Error()
			}
		}
		items = append(items, map[string]any{"id": w.ExecutionIdentityID, "os_identity": identity, "restriction_verified": verified, "config": map[string]any{"mode": kind, "network_policies": network, "reason": reason}})
	}
	return items
}
func (s *Service) VerifyIdentity(ctx context.Context, id string) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var w Workspace
	found := false
	for _, candidate := range s.Config.Workspaces {
		if candidate.ExecutionIdentityID == id {
			w = candidate
			found = true
			break
		}
	}
	if !found {
		return nil, errors.New("identity_not_enrolled")
	}
	if s.ExternalWorkspaceBusy != nil {
		if e := s.ExternalWorkspaceBusy(w.ID); e != nil {
			return nil, e
		}
	}
	records, e := s.Journal.All()
	if e != nil {
		return nil, e
	}
	for _, r := range records {
		if r.Request.WorkspaceID == w.ID && !protocol.Terminal(r.Receipt.State) {
			return nil, errors.New("workspace_busy_unresolved_operation")
		}
	}
	if w.NativeEnabled && !w.ContainerEnabled {
		runner, e := s.nativeRunner(w)
		if e != nil {
			return nil, e
		}
		sentinel := filepath.Join(w.Native.SpoolDir, "identity-denied-sentinel")
		if _, e = os.Stat(sentinel); errors.Is(e, os.ErrNotExist) {
			if e = os.WriteFile(sentinel, []byte("nonsecret identity restriction probe\n"), 0600); e != nil {
				return nil, e
			}
		}
		return runner.Verify(ctx, s.ExecutablePath, sentinel)
	}
	if !w.ContainerEnabled {
		return nil, errors.New("runtime_not_enabled")
	}
	if !imageDigest.MatchString(w.Image) || !userID.MatchString(w.User) || w.TimeoutPath != "/usr/bin/timeout" || w.CPUs <= 0 || w.MemoryBytes < 16<<20 || w.PidsLimit < 1 {
		return nil, errors.New("container_identity_policy_invalid")
	}
	proofPath := filepath.Join(s.Config.DataDir, "container-proof-"+w.ID+".json")
	os.Remove(proofPath)
	var nonce [16]byte
	if _, e = rand.Read(nonce[:]); e != nil {
		return nil, e
	}
	operation := "identity-" + hex.EncodeToString(nonce[:])
	request := protocol.Request{OperationID: operation, Command: protocol.Command{Executable: "/usr/bin/id", Args: []string{"-u"}}, Limits: protocol.Limits{PerCommandTimeoutSeconds: 10, WallTimeSeconds: 10, MaxOutputBytes: 8192}}
	record := Record{Request: request, Container: "hl-" + operation}
	if e = s.Backend.Create(ctx, record, w); e != nil {
		return nil, errors.New("container_identity_create_failed")
	}
	if e = s.Backend.Start(ctx, record.Container); e != nil {
		return nil, errors.New("container_identity_start_unknown")
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		status, e := s.Backend.Inspect(ctx, record.Container)
		if e != nil {
			return nil, e
		}
		if !status.Exists || status.OperationID != operation {
			return nil, errors.New("container_identity_mismatch")
		}
		if !status.Running {
			if status.ExitCode != 0 {
				return nil, errors.New("container_identity_probe_failed")
			}
			out, _, e := s.Backend.Logs(ctx, record.Container, 8192)
			if e != nil || strings.TrimSpace(string(out)) != strings.Split(w.User, ":")[0] {
				return nil, errors.New("container_execution_uid_mismatch")
			}
			proof := map[string]any{"verified": true, "observed_at": time.Now().UTC(), "user": w.User, "image": w.Image, "root": w.Root}
			b, _ := json.Marshal(proof)
			if e = os.WriteFile(proofPath, b, 0600); e != nil {
				return nil, e
			}
			return proof, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	s.Backend.Stop(context.Background(), record.Container)
	return nil, errors.New("container_identity_timeout")
}
