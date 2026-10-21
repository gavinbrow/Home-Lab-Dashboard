package supervisor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"homelab/agent/internal/backup"
	"homelab/agent/internal/hostops"
	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
	"homelab/agent/internal/terminal"
)

type Workspace struct {
	Terminal              *terminal.Config `json:"terminal,omitempty"`
	ID                    string           `json:"id"`
	Root                  string           `json:"root"`
	Revision              int              `json:"revision"`
	ExecutionIdentityID   string           `json:"execution_identity_id"`
	EnvironmentID         string           `json:"environment_id"`
	EnvironmentGeneration int              `json:"environment_generation"`
	Image                 string           `json:"image"`
	User                  string           `json:"user"`
	CPUs                  float64          `json:"cpus"`
	MemoryBytes           int64            `json:"memory_bytes"`
	PidsLimit             int              `json:"pids_limit"`
	MaxOutputBytes        int64            `json:"max_output_bytes"`
	TimeoutPath           string           `json:"timeout_path"`
	PolicyRevision        int              `json:"policy_revision"`
	GrantIDs              []string         `json:"grant_ids"`
	Writable              bool             `json:"writable"`
	ContainerEnabled      bool             `json:"container_enabled"`
	NativeEnabled         bool             `json:"native_enabled"`
	Native                *native.Config   `json:"native,omitempty"`
	NativeNetworkPolicy   string           `json:"native_network_policy"`
	ApprovedRootID        string           `json:"approved_root_id"`
	RuntimePath           string           `json:"runtime_path"`
	Type                  string           `json:"type"`
	QuotaBytes            int64            `json:"quota_bytes"`
	DeletionGrantID       string           `json:"deletion_grant_id"`
	RecoveryGrantID       string           `json:"recovery_grant_id"`
	RuntimeID             string           `json:"runtime_id"`
	EnvironmentGrantIDs   []string         `json:"environment_grant_ids"`
	EnvironmentCommand    []string         `json:"environment_command"`
	State                 string           `json:"state"`
}
type Config struct {
	RecoveryMode              bool             `json:"recovery_mode,omitempty"`
	MachineIdentityGeneration string           `json:"machine_identity_generation,omitempty"`
	Backup                    backup.Config    `json:"backup"`
	MachineID                 string           `json:"machine_id"`
	DispatchEpoch             string           `json:"dispatch_epoch"`
	DataDir                   string           `json:"data_dir"`
	Listen                    string           `json:"listen"`
	LocalTokenFile            string           `json:"local_token_file"`
	DockerPath                string           `json:"docker_path"`
	Workspaces                []Workspace      `json:"workspaces"`
	RequireSignedRPC          bool             `json:"require_signed_rpc"`
	DispatchKeyID             string           `json:"dispatch_key_id"`
	DispatchPublicKeyFile     string           `json:"dispatch_public_key_file"`
	IdentityDir               string           `json:"identity_dir"`
	Targets                   []hostops.Target `json:"targets"`
	SystemctlPath             string           `json:"systemctl_path"`
	SCPath                    string           `json:"sc_path"`
	JournalctlPath            string           `json:"journalctl_path"`
}
type ContainerStatus struct {
	Exists      bool
	Running     bool
	ExitCode    int
	ID          string
	OperationID string
	Created     bool
}
type Backend interface {
	Create(context.Context, Record, Workspace) error
	Start(context.Context, string) error
	Inspect(context.Context, string) (ContainerStatus, error)
	Stop(context.Context, string) error
	Logs(context.Context, string, int64) ([]byte, bool, error)
}
type Service struct {
	Config                Config
	Journal               *Journal
	Backend               Backend
	BootID                string
	mu                    sync.Mutex
	nativeRunners         map[string]*native.Runner
	nativeConfigs         map[string]native.Config
	ExternalWorkspaceBusy func(string) error
	terminalMu            sync.Mutex
	terminalManagers      map[string]*terminal.Manager
	terminalConfigs       map[string]string
	ExecutablePath        string
}

func (s *Service) workspace(id string) (Workspace, bool) {
	for _, w := range s.Config.Workspaces {
		if w.ID == id {
			return w, true
		}
	}
	return Workspace{}, false
}

// ApplyEnvironmentLocked is invoked only inside WithWorkspaceWrite's guard. The
// protected configuration is persisted before dispatch can see the new binding.
func (s *Service) ApplyEnvironmentLocked(b hostops.WorkspaceBinding, persist func(Config) error) error {
	next := s.Config
	next.Workspaces = append([]Workspace(nil), s.Config.Workspaces...)
	found := false
	for i := range next.Workspaces {
		if next.Workspaces[i].ID == b.WorkspaceID {
			w := &next.Workspaces[i]
			w.RuntimeID = b.RuntimeID
			w.Revision = b.Revision
			w.State = b.State
			w.EnvironmentID = ""
			w.EnvironmentGeneration = 0
			if b.EnvironmentID != nil {
				w.EnvironmentID = *b.EnvironmentID
			}
			if b.EnvironmentGeneration != nil {
				w.EnvironmentGeneration = *b.EnvironmentGeneration
			}
			found = true
		}
	}
	if !found {
		return errors.New("workspace_not_enrolled")
	}
	if persist != nil {
		if e := persist(next); e != nil {
			return e
		}
	}
	s.Config = next
	return nil
}

// WithWorkspaceWrite serializes local file mutations with dispatch and preserves
// the host reservation even when central worker leases or network sessions end.
func (s *Service) WithWorkspaceWrite(id string, mutation func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ExternalWorkspaceBusy != nil {
		if e := s.ExternalWorkspaceBusy(id); e != nil {
			return e
		}
	}
	records, e := s.Journal.All()
	if e != nil {
		return e
	}
	for _, r := range records {
		if r.Request.WorkspaceID == id && !protocol.Terminal(r.Receipt.State) {
			return errors.New("workspace_busy_unresolved_operation")
		}
	}
	return mutation()
}

// WithWorkspaceMutation is reserved for the durable hostops manager, which has
// already checked/persisted its own reservation. Other clients use WithWorkspaceWrite.
func (s *Service) WithWorkspaceMutation(id string, mutation func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, e := s.Journal.All()
	if e != nil {
		return e
	}
	for _, r := range records {
		if r.Request.WorkspaceID == id && !protocol.Terminal(r.Receipt.State) {
			return errors.New("workspace_busy_unresolved_operation")
		}
	}
	return mutation()
}
func (s *Service) WithJournalBackup(capture func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	records, e := s.Journal.All()
	if e != nil {
		return e
	}
	for _, record := range records {
		if !protocol.Terminal(record.Receipt.State) {
			return errors.New("journal_backup_unresolved_operation")
		}
	}
	if s.ExternalWorkspaceBusy != nil {
		for _, w := range s.Config.Workspaces {
			if e = s.ExternalWorkspaceBusy(w.ID); e != nil {
				return e
			}
		}
	}
	return capture()
}

var imageDigest = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$`)
var userID = regexp.MustCompile(`^[1-9][0-9]*:[1-9][0-9]*$`)

func (s *Service) Authorize(r protocol.Request) error {
	if s.Config.RecoveryMode {
		return errors.New("host_recovery_mode_execution_disabled")
	}
	if e := s.validateInstallationGeneration(r.MachineIdentityGeneration); e != nil {
		return e
	}
	if e := r.Validate(); e != nil {
		return e
	}
	if r.MachineID != s.Config.MachineID {
		return errors.New("wrong_machine")
	}
	if r.DispatchEpoch != s.Config.DispatchEpoch {
		return ErrFence
	}
	w, ok := s.workspace(r.WorkspaceID)
	if !ok {
		return errors.New("workspace_not_enrolled")
	}
	if w.State != "" && w.State != "active" {
		return errors.New("workspace_not_active")
	}
	if !w.ContainerEnabled && !w.NativeEnabled {
		return errors.New("native_execution_disabled_identity_and_containment_unverified")
	}
	if w.ContainerEnabled && runtime.GOOS != "linux" {
		return errors.New("container_execution_requires_linux_host")
	}
	if r.NetworkPolicy != nil {
		if r.NetworkPolicy.Mode != "deny" && r.NetworkPolicy.Mode != "runtime_default" {
			return errors.New("network_allowlist_unenforceable")
		}
		if len(r.NetworkPolicy.AllowedHosts) != 0 {
			return errors.New("network_allowlist_unenforceable")
		}
	}
	if r.ExecutionIdentityID != w.ExecutionIdentityID || r.WorkspaceRevision != w.Revision {
		return errors.New("workspace_identity_or_generation_mismatch")
	}
	if w.ContainerEnabled && (r.EnvironmentID == nil || *r.EnvironmentID != w.EnvironmentID || r.EnvironmentGeneration == nil || *r.EnvironmentGeneration != w.EnvironmentGeneration) {
		return errors.New("workspace_identity_or_generation_mismatch")
	}
	if w.NativeEnabled && !w.ContainerEnabled && (r.EnvironmentID != nil || r.EnvironmentGeneration != nil) {
		return errors.New("native_environment_must_be_null")
	}
	if r.PolicyRevision != w.PolicyRevision || r.Grant.Revision != w.PolicyRevision || !slices.Contains(w.GrantIDs, r.Grant.ID) || !slices.Contains(r.Grant.MachineIDs, r.MachineID) || !slices.Contains(r.Grant.WorkspaceIDs, r.WorkspaceID) || !slices.Contains(r.Grant.Tools, "run_command") {
		return errors.New("grant_denied")
	}
	if r.SavedAction != nil && !slices.Contains(r.Grant.Tools, "actions.run") {
		return errors.New("saved_action_requires_actions_run_and_run_command")
	}
	if !w.Writable {
		return errors.New("workspace_read_only")
	}
	if w.NativeEnabled && !w.ContainerEnabled {
		runner, e := s.nativeRunner(w)
		if e != nil {
			return e
		}
		if r.Limits.MaxOutputBytes > w.MaxOutputBytes {
			return errors.New("output_limit_exceeds_host_policy")
		}
		return runner.Validate(nativeSpec(r, w))
	}
	if !imageDigest.MatchString(w.Image) || !userID.MatchString(w.User) || w.CPUs <= 0 || w.CPUs > 64 || w.MemoryBytes < 16<<20 || w.PidsLimit < 1 || w.PidsLimit > 4096 || w.MaxOutputBytes < 1 || w.MaxOutputBytes > 1<<30 || w.TimeoutPath != "/usr/bin/timeout" {
		return errors.New("container_policy_unverified")
	}
	if r.Limits.MaxOutputBytes > w.MaxOutputBytes {
		return errors.New("output_limit_exceeds_host_policy")
	}
	if r.Command.Cwd != "/workspace/project" || len(r.Command.Env) > 0 {
		return errors.New("unsupported_cwd_or_environment")
	}
	if !strings.HasPrefix(r.Command.Executable, "/") {
		return errors.New("absolute_container_executable_required")
	}
	root, e := filepath.EvalSymlinks(w.Root)
	if e != nil {
		return errors.New("workspace_root_unavailable")
	}
	if root != w.Root || !filepath.IsAbs(root) || strings.Contains(root, ",") {
		return errors.New("workspace_root_must_be_canonical")
	}
	info, e := os.Stat(root)
	if e != nil || !info.IsDir() {
		return errors.New("workspace_root_unavailable")
	}
	return nil
}
func (s *Service) Dispatch(r protocol.Request) (protocol.Receipt, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Replays return the durable record before current grants are checked. They
	// cannot launch anything; fresh dispatch still validates current local policy.
	if old, e := s.Journal.Get(r.OperationID); e == nil {
		if old.Request.RequestHash != r.RequestHash {
			return protocol.Receipt{}, ErrConflict
		}
		h, e := protocol.Hash(r)
		if e != nil || h != r.RequestHash {
			return protocol.Receipt{}, errors.New("request_hash_mismatch")
		}
		if r.DispatchEpoch != s.Config.DispatchEpoch {
			return protocol.Receipt{}, ErrFence
		}
		if e = s.Journal.CheckFence(old, r.Fence, r.DispatchEpoch); e != nil {
			return protocol.Receipt{}, e
		}
		return old.Receipt, nil
	}
	if e := s.Authorize(r); e != nil {
		return protocol.Receipt{}, e
	}
	if s.ExternalWorkspaceBusy != nil {
		if e := s.ExternalWorkspaceBusy(r.WorkspaceID); e != nil {
			return protocol.Receipt{}, e
		}
	}
	all, e := s.Journal.All()
	if e != nil {
		return protocol.Receipt{}, e
	}
	for _, x := range all {
		if x.Request.WorkspaceID == r.WorkspaceID && !protocol.Terminal(x.Receipt.State) {
			return protocol.Receipt{}, errors.New("workspace_busy_unresolved_operation")
		}
	}
	rec, _, e := s.Journal.Accept(r, s.BootID, s.Config.DispatchEpoch)
	return rec.Receipt, e
}
func (s *Service) Cancel(id string, fence int64, epoch string) (protocol.Receipt, error) {
	if old, e := s.Journal.Get(id); e == nil && old.Request.Command.Executable == TerminalMarker {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, e = s.CancelTerminal(ctx, id, fence, epoch); e != nil {
			return protocol.Receipt{}, e
		}
		record, e := s.Journal.Get(id)
		return record.Receipt, e
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, e := s.Journal.Get(id)
	if e != nil {
		return protocol.Receipt{}, e
	}
	if epoch != s.Config.DispatchEpoch {
		return protocol.Receipt{}, ErrFence
	}
	if e = s.Journal.CheckFence(r, fence, epoch); e != nil {
		return protocol.Receipt{}, e
	}
	if protocol.Terminal(r.Receipt.State) {
		return r.Receipt, nil
	}
	if r.Receipt.State == "received" {
		r, e = s.Journal.Update(r, "cancelled", "cancelled_before_launch", nil)
		return r.Receipt, e
	}
	r, e = s.Journal.Update(r, "cancelling", "cancellation_requested", nil)
	return r.Receipt, e
}
func (s *Service) Run(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if e := s.Tick(ctx); e != nil {
			return e
		}
		if e := s.ReconcileTerminals(ctx); e != nil {
			return e
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func (s *Service) Tick(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Config.RecoveryMode {
		return nil
	}
	records, e := s.Journal.All()
	if e != nil {
		return e
	}
	for _, r := range records {
		if protocol.Terminal(r.Receipt.State) || r.Request.Command.Executable == TerminalMarker {
			continue
		}
		w, _ := s.workspace(r.Request.WorkspaceID)
		if w.NativeEnabled && !w.ContainerEnabled {
			if e = s.tickNative(ctx, r, w); e != nil {
				return e
			}
			continue
		}
		if r.Receipt.State == "received" {
			if time.Now().After(r.Deadline) {
				if _, e = s.Journal.Update(r, "interrupted", "dispatch_deadline_expired_before_launch", nil); e != nil {
					return e
				}
				continue
			}
			if e = s.Authorize(r.Request); e != nil {
				if _, e = s.Journal.Update(r, "rejected", e.Error(), nil); e != nil {
					return e
				}
				continue
			}
			r, e = s.Journal.Update(r, "launching", "launch_in_progress", nil)
			if e != nil {
				return e
			}
			if e = s.Backend.Create(ctx, r, w); e != nil {
				if _, e = s.Journal.Update(r, "outcome_unknown", "container_create_ack_unknown", nil); e != nil {
					return e
				}
				continue
			}
			if time.Now().After(r.Deadline) {
				if _, e = s.Journal.Update(r, "interrupted", "dispatch_deadline_expired_during_prepare", nil); e != nil {
					return e
				}
				continue
			}
			if e = s.Backend.Start(ctx, r.Container); e != nil {
				if _, e = s.Journal.Update(r, "outcome_unknown", "container_start_ack_unknown", nil); e != nil {
					return e
				}
				continue
			}
			r, e = s.Journal.Update(r, "running", "container_started", nil)
			if e != nil {
				return e
			}
		}
		status, err := s.Backend.Inspect(ctx, r.Container)
		if err != nil {
			continue
		}
		if !status.Exists {
			if r.Receipt.State != "outcome_unknown" {
				if _, e = s.Journal.Update(r, "outcome_unknown", "containment_missing_no_replay", nil); e != nil {
					return e
				}
			}
			continue
		}
		if status.OperationID != r.Request.OperationID {
			if _, e = s.Journal.Update(r, "outcome_unknown", "containment_identity_mismatch", nil); e != nil {
				return e
			}
			continue
		}
		if status.Running && (r.Receipt.State == "cancelling" || time.Now().After(r.Deadline)) {
			if e = s.Backend.Stop(ctx, r.Container); e != nil {
				continue
			}
			status, err = s.Backend.Inspect(ctx, r.Container)
			if err != nil || status.Running {
				continue
			}
		}
		if err = s.captureLogs(ctx, r); err != nil {
			return err
		}
		if !status.Running {
			state, reason := "succeeded", "process_exited"
			if status.ExitCode != 0 {
				state = "failed"
			}
			if status.Created {
				state = "interrupted"
				reason = "container_created_but_command_never_started"
			}
			if r.Receipt.State == "cancelling" {
				state = "cancelled"
				reason = "containment_stopped_verified"
			} else if status.ExitCode == 124 || status.ExitCode == 137 {
				state = "failed"
				reason = "command_timeout_or_runtime_kill"
			}
			if native.KernelBootChanged(r.Receipt.BootID, s.BootID) {
				state = "interrupted"
				reason = "host_boot_changed_original_execution_ended"
			}
			if _, e = s.Journal.Update(r, state, reason, &status.ExitCode); e != nil {
				return e
			}
		} else if native.KernelBootChanged(r.Receipt.BootID, s.BootID) {
			if r.Receipt.State != "outcome_unknown" {
				if _, e = s.Journal.Update(r, "outcome_unknown", "host_boot_changed_containment_requires_reconciliation", nil); e != nil {
					return e
				}
			}
		} else if r.Receipt.State != "running" && r.Receipt.State != "cancelling" {
			if _, e = s.Journal.Update(r, "running", "reattached_original_containment", nil); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *Service) captureLogs(ctx context.Context, r Record) error {
	b, truncated, e := s.Backend.Logs(ctx, r.Container, r.Request.Limits.MaxOutputBytes)
	if e != nil {
		return nil
	}
	var offset int64
	if e = s.Journal.db.QueryRow(`SELECT COALESCE(SUM(length(data)),0) FROM logs WHERE operation=? AND truncated=0`, r.Request.OperationID).Scan(&offset); e != nil {
		return e
	}
	for int(offset) < len(b) {
		end := min(int(offset)+16384, len(b))
		if e = s.Journal.AppendLog(r.Request.OperationID, "combined", string(b[offset:end]), false); e != nil {
			return e
		}
		offset = int64(end)
	}
	if truncated {
		var count int
		if e = s.Journal.db.QueryRow(`SELECT COUNT(*) FROM logs WHERE operation=? AND truncated=1`, r.Request.OperationID).Scan(&count); e != nil {
			return e
		}
		if count == 0 {
			return s.Journal.AppendLog(r.Request.OperationID, "system", "output_truncated_at_host_quota", true)
		}
	}
	return nil
}

type Docker struct {
	Executable string
	HelperPath string
}
type boundedWriter struct {
	b         []byte
	max       int64
	truncated bool
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	n := len(p)
	room := w.max - int64(len(w.b))
	if room < int64(n) {
		w.truncated = true
	}
	if room > 0 {
		w.b = append(w.b, p[:min(int64(n), room)]...)
	}
	return n, nil
}
func (d Docker) run(ctx context.Context, max int64, args ...string) ([]byte, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, d.Executable, args...)
	w := &boundedWriter{max: max}
	cmd.Stdout = w
	cmd.Stderr = w
	e := cmd.Run()
	return w.b, w.truncated, e
}
func (d Docker) Create(ctx context.Context, r Record, w Workspace) error {
	timeout := min(r.Request.Limits.PerCommandTimeoutSeconds, r.Request.Limits.WallTimeSeconds)
	if !r.Deadline.IsZero() {
		timeout = min(timeout, max(1, int(math.Ceil(time.Until(r.Deadline).Seconds()))))
	}
	if !filepath.IsAbs(d.HelperPath) || strings.Contains(d.HelperPath, ",") {
		return errors.New("trusted_container_helper_path_required")
	}
	args := []string{"create", "--name", r.Container, "--label", "homelab.operation=" + r.Request.OperationID, "--label", "homelab.workspace=" + w.ID, "--label", "homelab.environment=" + w.EnvironmentID, "--restart=no", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--user", w.User, "--cpus", strconv.FormatFloat(w.CPUs, 'f', 2, 64), "--memory", strconv.FormatInt(w.MemoryBytes, 10), "--memory-swap", strconv.FormatInt(w.MemoryBytes, 10), "--pids-limit", strconv.Itoa(w.PidsLimit), "--tmpfs", "/tmp:rw,noexec,nosuid,size=67108864", "--env", "HOME=/tmp", "--workdir", "/workspace/project", "--mount", "type=bind,source=" + w.Root + ",target=/workspace/project", "--mount", "type=bind,source=" + d.HelperPath + ",target=/homelab-agent,readonly", "--log-driver", "json-file", "--log-opt", "max-size=" + strconv.FormatInt(2*r.Request.Limits.MaxOutputBytes+8<<20, 10), "--log-opt", "max-file=1", "--entrypoint", "/homelab-agent", w.Image, "container-run", "--timeout", strconv.Itoa(timeout), "--max-output", strconv.FormatInt(r.Request.Limits.MaxOutputBytes, 10), "--", r.Request.Command.Executable}
	args = append(args, r.Request.Command.Args...)
	args = slices.Insert(args, 1, "--env", "HOMELAB_OPERATION_ID="+r.Request.OperationID, "--env", "HOMELAB_JOB_ID="+r.Request.JobID, "--env", "HOMELAB_WORKSPACE_ID="+w.ID)
	_, _, e := d.run(ctx, 4096, args...)
	return e
}
func (d Docker) Start(ctx context.Context, name string) error {
	_, _, e := d.run(ctx, 4096, "start", name)
	return e
}
func (d Docker) Inspect(ctx context.Context, name string) (ContainerStatus, error) {
	out, _, e := d.run(ctx, 8192, "inspect", "--format", "{{.Id}}|{{.State.Running}}|{{.State.ExitCode}}|{{index .Config.Labels \"homelab.operation\"}}|{{.State.Status}}", name)
	if e != nil {
		if strings.Contains(string(out), "No such object") {
			return ContainerStatus{}, nil
		}
		return ContainerStatus{}, e
	}
	p := strings.Split(strings.TrimSpace(string(out)), "|")
	if len(p) != 5 {
		return ContainerStatus{}, errors.New("invalid_container_status")
	}
	code, e := strconv.Atoi(p[2])
	return ContainerStatus{Exists: true, ID: p[0], Running: p[1] == "true", ExitCode: code, OperationID: p[3], Created: p[4] == "created"}, e
}
func (d Docker) Stop(ctx context.Context, name string) error {
	_, _, e := d.run(ctx, 4096, "stop", "--time", "5", name)
	return e
}
func (d Docker) Logs(ctx context.Context, name string, max int64) ([]byte, bool, error) {
	raw, limit, e := d.run(ctx, 2*max+8<<20, "logs", name)
	if e != nil {
		return nil, false, e
	}
	var out bytes.Buffer
	truncated := limit
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 32768), 1<<20)
	for scanner.Scan() {
		var chunk struct {
			Version   int    `json:"homelab_log"`
			Data      string `json:"data"`
			Truncated bool   `json:"truncated"`
		}
		if e = json.Unmarshal(scanner.Bytes(), &chunk); e != nil || chunk.Version != 1 {
			return nil, false, errors.New("invalid_container_log_frame")
		}
		if chunk.Truncated {
			truncated = true
		}
		if chunk.Data != "" {
			b, e := base64.StdEncoding.DecodeString(chunk.Data)
			if e != nil {
				return nil, false, e
			}
			room := max - int64(out.Len())
			if int64(len(b)) > room {
				b = b[:room]
				truncated = true
			}
			out.Write(b)
		}
	}
	if e = scanner.Err(); e != nil {
		return nil, false, e
	}
	return out.Bytes(), truncated, nil
}

func (s *Service) validateInstallationGeneration(generation string) error {
	if generation != s.Config.MachineIdentityGeneration {
		return errors.New("machine_identity_generation_mismatch")
	}
	return nil
}

// WithStateMaintenance excludes the encrypted backup cut while allowing cache
// tombstoning during active commands/consoles. It never changes project bytes.
func (s *Service) WithStateMaintenance(fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return fn()
}
