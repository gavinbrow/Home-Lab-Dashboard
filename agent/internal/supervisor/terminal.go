package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"time"

	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
	"homelab/agent/internal/terminal"
	"os"
)

const TerminalMarker = "__workspace_terminal__"

func (s *Service) authorizeTerminal(r protocol.Request) error {
	if e := r.Validate(); e != nil {
		return e
	}
	if r.Command.Executable != TerminalMarker || len(r.Command.Args) != 0 || len(r.Command.Env) != 0 || r.SavedAction != nil || !slices.Contains(r.Grant.Tools, "workspace.terminal") {
		return errors.New("terminal_permission_or_marker_denied")
	}
	w, ok := s.workspace(r.WorkspaceID)
	if !ok || w.Terminal == nil {
		return errors.New("terminal_not_configured")
	}
	if r.NetworkPolicy != nil && (r.NetworkPolicy.Mode == "allowlist" || r.NetworkPolicy.Mode == "deny" && w.Terminal.NetworkPolicy != "none") {
		return errors.New("terminal_network_policy_unenforceable")
	}
	copy := r
	copy.Command = protocol.Command{Executable: w.Terminal.Shell, Args: w.Terminal.Args, Cwd: w.Root, Env: map[string]string{}}
	if w.ContainerEnabled {
		copy.Command.Cwd = "/workspace/project"
	}
	copy.RequestHash, _ = protocol.Hash(copy)
	return s.Authorize(copy)
}
func (s *Service) terminalAcquire(spec terminal.Spec) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := spec.Request
	if e := s.authorizeTerminal(r); e != nil {
		return e
	}
	if old, e := s.Journal.Get(r.OperationID); e == nil {
		if old.Request.RequestHash != r.RequestHash {
			return ErrConflict
		}
		return errors.New("terminal_existing_operation_requires_reconciliation")
	}
	if s.ExternalWorkspaceBusy != nil {
		if e := s.ExternalWorkspaceBusy(r.WorkspaceID); e != nil {
			return e
		}
	}
	records, e := s.Journal.All()
	if e != nil {
		return e
	}
	for _, v := range records {
		if v.Request.WorkspaceID == r.WorkspaceID && !protocol.Terminal(v.Receipt.State) {
			return errors.New("workspace_busy_unresolved_operation")
		}
	}
	rec, _, e := s.Journal.Accept(r, s.BootID, s.Config.DispatchEpoch)
	if e != nil {
		return e
	}
	if time.Until(rec.Deadline)+time.Second < time.Duration(min(r.Limits.WallTimeSeconds, r.Limits.PerCommandTimeoutSeconds))*time.Second {
		_, _ = s.Journal.Update(rec, "rejected", "terminal_job_budget_insufficient", nil)
		return errors.New("terminal_job_budget_insufficient")
	}
	_, e = s.Journal.Update(rec, "running", "restricted_terminal_writer_reserved", nil)
	return e
}
func (s *Service) terminalRelease(rec terminal.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, e := s.Journal.Get(rec.ID)
	if e != nil {
		return e
	}
	if old.Request.RequestHash != rec.Request.RequestHash {
		return ErrConflict
	}
	if rec.State != "exited" {
		return errors.New("terminal_exit_not_proven")
	}
	if protocol.Terminal(old.Receipt.State) {
		if old.Receipt.ExitCode == nil && rec.ExitCode != nil || old.Receipt.ExitCode != nil && (rec.ExitCode == nil || *old.Receipt.ExitCode != *rec.ExitCode) {
			return errors.New("terminal_final_receipt_conflict")
		}
		return nil
	}
	state := "succeeded"
	if rec.ExitCode == nil || *rec.ExitCode != 0 {
		state = "failed"
	}
	_, e = s.Journal.Update(old, state, rec.Reason, rec.ExitCode)
	return e
}
func (s *Service) TerminalManager(workspace string) (*terminal.Manager, error) {
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()
	s.mu.Lock()
	w, ok := s.workspace(workspace)
	s.mu.Unlock()
	if !ok || w.Terminal == nil {
		return nil, errors.New("terminal_not_configured")
	}
	c := *w.Terminal
	c.BootID = s.BootID
	c.Acquire = nil
	c.Release = nil
	if w.ContainerEnabled {
		if c.Container == nil {
			return nil, errors.New("terminal_container_policy_required")
		}
		copy := *c.Container
		c.Container = &copy
		c.Container.MachineID = s.Config.MachineID
		c.Container.WorkspaceID = w.ID
		c.Container.EnvironmentID = w.EnvironmentID
		c.Container.Generation = w.EnvironmentGeneration
		c.Container.RuntimeID = w.RuntimeID
		c.Container.Root = w.Root
		c.Container.User = w.User
		c.Container.ImageDigest = w.Image
		c.Container.CPUs = w.CPUs
		c.Container.MemoryBytes = w.MemoryBytes
		c.Container.PidsLimit = w.PidsLimit
		c.Container.DockerPath = s.Config.DockerPath
		c.Container.HelperPath = s.ExecutablePath
		if c.Container.SpoolDir == "" {
			c.Container.SpoolDir = filepath.Join(s.Config.DataDir, "terminal-spool", w.ID)
		}
		if e := os.MkdirAll(c.Container.SpoolDir, 0700); e != nil {
			return nil, e
		}
		c.DataDir = filepath.Join(c.Container.SpoolDir, "sessions")
	} else {
		if !w.NativeEnabled || w.Native == nil {
			return nil, errors.New("terminal_restricted_identity_required")
		}
		c.Native = *w.Native
		c.DataDir = filepath.Join(w.Native.SpoolDir, "terminals")
	}
	if c.Limits.MemoryBytes > w.MemoryBytes || c.Limits.Pids > w.PidsLimit || c.Limits.MaxOutputBytes > w.MaxOutputBytes || c.Limits.CPUPercent > int(w.CPUs*100) {
		return nil, errors.New("terminal_limits_exceed_host_policy")
	}
	raw, _ := json.Marshal(c)
	key := string(raw)
	if s.terminalManagers == nil {
		s.terminalManagers = map[string]*terminal.Manager{}
		s.terminalConfigs = map[string]string{}
	}
	if m := s.terminalManagers[workspace]; m != nil {
		if s.terminalConfigs[workspace] == key {
			return m, nil
		}
		for _, rec := range m.List() {
			if rec.State != "exited" {
				return nil, errors.New("terminal_policy_changed_writer_reconciliation_required")
			}
		}
		if e := m.Close(); e != nil {
			return nil, e
		}
		delete(s.terminalManagers, workspace)
	}
	c.Acquire = s.terminalAcquire
	c.Release = s.terminalRelease
	m, e := terminal.New(c)
	if e != nil {
		return nil, e
	}
	s.terminalManagers[workspace] = m
	s.terminalConfigs[workspace] = key
	return m, nil
}
func (s *Service) TerminalByID(id string) (*terminal.Manager, protocol.Request, error) {
	r, e := s.Journal.Get(id)
	if e != nil {
		return nil, protocol.Request{}, e
	}
	if r.Request.Command.Executable != TerminalMarker {
		return nil, protocol.Request{}, errors.New("not_a_terminal_operation")
	}
	m, e := s.TerminalManager(r.Request.WorkspaceID)
	return m, r.Request, e
}
func (s *Service) TerminalAccess(id string, mutation bool) (*terminal.Manager, error) {
	m, r, e := s.TerminalByID(id)
	if e != nil {
		return nil, e
	}
	if mutation {
		s.mu.Lock()
		e = s.authorizeTerminal(r)
		s.mu.Unlock()
		if e != nil {
			return nil, e
		}
	}
	return m, nil
}
func (s *Service) StartTerminal(ctx context.Context, spec terminal.Spec) (terminal.Record, error) {
	s.mu.Lock()
	e := s.authorizeTerminal(spec.Request)
	if e == nil {
		if old, err := s.Journal.Get(spec.Request.OperationID); err == nil {
			if old.Request.RequestHash != spec.Request.RequestHash {
				e = ErrConflict
			} else {
				e = s.Journal.CheckFence(old, spec.Request.Fence, spec.Request.DispatchEpoch)
			}
		}
	}
	s.mu.Unlock()
	if e != nil {
		return terminal.Record{}, e
	}
	m, e := s.TerminalManager(spec.Request.WorkspaceID)
	if e != nil {
		return terminal.Record{}, e
	}
	return m.Start(ctx, spec)
}
func (s *Service) CancelTerminal(ctx context.Context, id string, fence int64, epoch string) (terminal.Record, error) {
	m, r, e := s.TerminalByID(id)
	if e != nil {
		return terminal.Record{}, e
	}
	s.mu.Lock()
	if epoch != s.Config.DispatchEpoch {
		e = ErrFence
	} else {
		e = s.Journal.CheckFence(Record{Request: r}, fence, epoch)
	}
	s.mu.Unlock()
	if e != nil {
		return terminal.Record{}, e
	}
	return m.Cancel(ctx, id)
}
func (s *Service) RecoverTerminals() error {
	for _, w := range s.Config.Workspaces {
		if w.Terminal != nil {
			if _, e := s.TerminalManager(w.ID); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *Service) CloseTerminals() {
	s.terminalMu.Lock()
	defer s.terminalMu.Unlock()
	for _, m := range s.terminalManagers {
		_ = m.Close()
	}
}

// Revocation, policy and environment changes terminate existing writers; reconnect
// is never authority to keep an obsolete grant running.
func (s *Service) ReconcileTerminals(ctx context.Context) error {
	s.terminalMu.Lock()
	managers := make([]*terminal.Manager, 0, len(s.terminalManagers))
	for _, m := range s.terminalManagers {
		managers = append(managers, m)
	}
	s.terminalMu.Unlock()
	for _, m := range managers {
		for _, rec := range m.List() {
			if rec.State == "exited" {
				continue
			}
			// Only protected journal state and the actual kernel boot identity
			// authorize native reboot recovery. Caller-supplied boot assertions are
			// never used; container sessions require exact runtime inspection.
			s.mu.Lock()
			old, journalErr := s.Journal.Get(rec.ID)
			w, configured := s.workspace(rec.Request.WorkspaceID)
			bootChanged := journalErr == nil && configured && !w.ContainerEnabled && rec.BootID == old.Receipt.BootID && native.KernelBootChanged(rec.BootID, s.BootID)
			s.mu.Unlock()
			if bootChanged {
				if _, e := m.ConfirmHostBootChanged(rec.ID, rec.BootID, s.BootID); e == nil {
					continue
				}
			}
			s.mu.Lock()
			e := s.authorizeTerminal(rec.Request)
			s.mu.Unlock()
			if e != nil {
				if _, e = m.Cancel(ctx, rec.ID); e != nil {
					return e
				}
			}
		}
	}
	return nil
}
