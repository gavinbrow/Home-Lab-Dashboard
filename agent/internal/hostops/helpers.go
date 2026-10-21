package hostops

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"homelab/agent/internal/files"
	"homelab/agent/internal/protocol"
	"net/http"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"
)

type limitedOutput struct {
	bytes.Buffer
	max int
}

func (b *limitedOutput) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < b.max {
		_, _ = b.Buffer.Write(p[:min(n, b.max-b.Len())])
	}
	return n, nil
}

type Result struct {
	Status   string `json:"status"`
	ExitCode int    `json:"exit_code"`
	Output   string `json:"output,omitempty"`
}

func run(ctx context.Context, exe string, max int, args ...string) (Result, error) {
	if !filepath.IsAbs(exe) {
		return Result{}, errors.New("absolute_helper_required")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, args...)
	o := &limitedOutput{max: max}
	cmd.Stdout = o
	cmd.Stderr = o
	e := cmd.Run()
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	s := "completed"
	if e != nil {
		s = "failed"
	}
	return Result{s, code, o.String()}, e
}

var serviceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$`)

func RunService(ctx context.Context, exe, platform, name, verb string, max int) (Result, error) {
	if !serviceName.MatchString(name) || !slices.Contains([]string{"start", "stop", "restart", "status", "logs"}, verb) {
		return Result{}, errors.New("service_action_denied")
	}
	if platform != "linux" && platform != "windows" {
		return Result{}, errors.New("unsupported_platform")
	}
	if verb == "logs" {
		if platform == "windows" {
			return run(ctx, exe, max, "qe", "System", "/q:*[System[Provider[@Name='Service Control Manager']]] and *[EventData[Data='"+name+"']]", "/c:200", "/rd:true", "/f:RenderedXml")
		}
		return run(ctx, exe, max, "--no-pager", "--output=short-iso", "--lines=200", "--unit="+name)
	}
	status := func() (Result, error) {
		if platform == "windows" {
			out, e := run(ctx, exe, max, "queryex", name)
			if e != nil {
				return out, e
			}
			out.Status = "unknown"
			if regexp.MustCompile(`STATE\s*:\s*4\b`).MatchString(out.Output) {
				out.Status = "running"
			} else if regexp.MustCompile(`STATE\s*:\s*1\b`).MatchString(out.Output) {
				out.Status = "stopped"
			}
			return out, nil
		}
		out, e := run(ctx, exe, max, "--no-pager", "is-active", name)
		switch strings.TrimSpace(out.Output) {
		case "active":
			out.Status = "running"
			e = nil
		case "inactive", "failed":
			out.Status = "stopped"
			e = nil
		default:
			out.Status = "unknown"
		}
		return out, e
	}
	wait := func(want string) (Result, error) {
		deadline := time.Now().Add(25 * time.Second)
		for {
			out, e := status()
			if e != nil {
				return out, e
			}
			if out.Status == want {
				return out, nil
			}
			if time.Now().After(deadline) {
				return out, errors.New("service_postcondition_unconfirmed")
			}
			select {
			case <-ctx.Done():
				return out, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	if verb == "status" {
		return status()
	}
	invoke := func(v string) (Result, error) {
		if platform == "windows" {
			return run(ctx, exe, max, v, name)
		}
		return run(ctx, exe, max, "--no-pager", v, name)
	}
	if platform == "windows" && verb == "restart" {
		if out, e := invoke("stop"); e != nil {
			return out, e
		}
		if out, e := wait("stopped"); e != nil {
			return out, e
		}
		verb = "start"
	}
	if out, e := invoke(verb); e != nil {
		return out, e
	}
	want := "running"
	if verb == "stop" {
		want = "stopped"
	}
	return wait(want)
}

type actionRequest struct {
	MachineIdentityGeneration string         `json:"machine_identity_generation,omitempty"`
	SchemaVersion             int            `json:"schema_version"`
	RequestHash               string         `json:"request_hash"`
	TargetKind                string         `json:"target_kind,omitempty"`
	OperationID               string         `json:"operation_id"`
	JobID                     string         `json:"job_id"`
	MachineID                 string         `json:"machine_id"`
	TargetID                  string         `json:"target_id"`
	Verb                      string         `json:"verb"`
	GrantID                   string         `json:"grant_id"`
	PolicyRevision            int            `json:"policy_revision"`
	Grant                     protocol.Grant `json:"grant"`
	Fence                     int64          `json:"fence"`
	DispatchEpoch             string         `json:"dispatch_epoch"`
	MaxLogBytes               int            `json:"max_log_bytes"`
}

func (m *Manager) action(w http.ResponseWriter, r *http.Request) {
	var q actionRequest
	rawBody, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	var logical map[string]any
	if e = json.Unmarshal(rawBody, &logical); e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	delete(logical, "request_hash")
	delete(logical, "fence")
	delete(logical, "dispatch_epoch")
	canonical, e := protocol.CanonicalJSON(logical)
	if e != nil || q.RequestHash != files.Hash(canonical) {
		http.Error(w, "request_hash_mismatch", 409)
		return
	}
	// The generation is part of the logical request hash as well as the signed
	// outer RPC. Installed pins require it; legacy unpinned fixtures accept only
	// an absent inner pin rather than trusting a caller-supplied generation.
	if q.MachineIdentityGeneration != m.config.MachineIdentityGeneration {
		http.Error(w, "machine_identity_generation_mismatch", 403)
		return
	}
	var target *Target
	for _, t := range m.config.Targets {
		if t.ID == r.PathValue("id") {
			v := t
			target = &v
		}
	}
	if target == nil || q.TargetKind != "" && q.TargetKind != target.Kind || q.SchemaVersion != 1 || q.PolicyRevision < 1 || q.Grant.OwnerID == "" || q.MachineID != m.config.MachineID || q.TargetID != target.ID || q.DispatchEpoch != m.config.DispatchEpoch || q.Fence < 1 || !safeID.MatchString(q.JobID) || q.GrantID != q.Grant.ID || q.Grant.Revision != target.PolicyRevision || q.PolicyRevision != target.PolicyRevision || !slices.Contains(target.GrantIDs, q.GrantID) || !slices.Contains(target.AllowedOperations, q.Verb) || !slices.Contains(q.Grant.Tools, "actions.run") || !slices.Contains(q.Grant.MachineIDs, m.config.MachineID) || q.Grant.RevokedAt != nil || q.MaxLogBytes < 1 || q.MaxLogBytes > 1<<20 {
		http.Error(w, "action_denied", 403)
		return
	}
	if q.Grant.ExpiresAt != nil {
		expiry, e := time.Parse(time.RFC3339Nano, *q.Grant.ExpiresAt)
		if e != nil || !expiry.After(time.Now()) {
			http.Error(w, "grant_expired", 403)
			return
		}
	}

	fence := q.Fence
	q.Fence = 0
	q.DispatchEpoch = ""
	body := canonical
	write(w, m.mutateChecked(q.OperationID, r.URL.Path, body, func() error { return m.checkFenceLocked(q.JobID, fence) }, func() (any, error) {
		switch target.Kind {
		case "service", "systemd", "windows_service":
			if target.Kind == "systemd" && runtime.GOOS != "linux" || target.Kind == "windows_service" && runtime.GOOS != "windows" {
				return nil, errors.New("target_platform_mismatch")
			}
			exe := m.config.SystemctlPath
			if runtime.GOOS == "windows" {
				exe = m.config.SCPath
				if q.Verb == "logs" {
					exe = m.config.WevtutilPath
				}
			} else if q.Verb == "logs" {
				exe = m.config.JournalctlPath
			}
			return RunService(r.Context(), exe, runtime.GOOS, target.Name, q.Verb, q.MaxLogBytes)
		case "container", "docker_container":
			ref := target.RuntimeID
			if ref == "" {
				ref = target.Name
			}
			return m.containerAction(r.Context(), ref, q.Verb, q.MaxLogBytes)
		default:
			return nil, errors.New("unsupported_target_kind")
		}
	}))
}
func (m *Manager) verifyContainerID(ctx context.Context, name, workspace string) (string, error) {
	if !serviceName.MatchString(name) {
		return "", errors.New("container_name_invalid")
	}
	a, e := run(ctx, m.config.DockerPath, 1<<20, "inspect", name)
	if e != nil {
		return "", e
	}
	return m.verifyContainerInspect([]byte(a.Output), workspace)
}

func (m *Manager) verifyContainerInspect(raw []byte, workspace string) (string, error) {
	var list []struct {
		ID     string `json:"Id"`
		Config struct {
			Labels map[string]string
			User   string
		}
		Mounts     []struct{ Source, Destination, Type string }
		HostConfig struct {
			Privileged     bool
			ReadonlyRootfs bool
			CapAdd         []string
			CapDrop        []string
			NetworkMode    string
			PidMode        string
			IpcMode        string
			SecurityOpt    []string
		}
	}
	if e := json.Unmarshal(raw, &list); e != nil || len(list) != 1 {
		return "", errors.New("container_inspect_invalid")
	}
	c := list[0]
	if c.Config.Labels["homelab.machine_id"] != m.config.MachineID || c.HostConfig.Privileged {
		return "", errors.New("container_ownership_unverified")
	}
	if workspace != "" && c.Config.Labels["homelab.workspace_id"] != workspace {
		return "", errors.New("container_workspace_mismatch")
	}
	if workspace != "" {
		binding, e := m.binding(workspace)
		if e != nil {
			return "", e
		}
		if !nonrootUser.MatchString(c.Config.User) || !c.HostConfig.ReadonlyRootfs || len(c.HostConfig.CapAdd) > 0 || !slices.Contains(c.HostConfig.CapDrop, "ALL") || c.HostConfig.NetworkMode != "none" || c.HostConfig.PidMode == "host" || c.HostConfig.IpcMode == "host" || !protocol.DockerNoNewPrivilegesEnabled(c.HostConfig.SecurityOpt) {
			return "", errors.New("environment_isolation_unverified")
		}
		for _, option := range c.HostConfig.SecurityOpt {
			if strings.Contains(strings.ToLower(option), "unconfined") {
				return "", errors.New("environment_isolation_unverified")
			}
		}
		ownedMount := false
		for _, mount := range c.Mounts {
			if mount.Type == "tmpfs" {
				continue
			}
			if mount.Type != "bind" || mount.Source != binding.CanonicalRoot || mount.Destination != "/workspace/project" {
				return "", errors.New("environment_storage_binding_mismatch")
			}
			ownedMount = true
		}
		if !ownedMount {
			return "", errors.New("environment_storage_binding_missing")
		}
	}
	for _, v := range c.Mounts {
		if strings.Contains(strings.ToLower(v.Source), "docker.sock") || strings.Contains(strings.ToLower(v.Destination), "docker.sock") {
			return "", errors.New("docker_socket_mount_forbidden")
		}
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(c.ID) {
		return "", errors.New("container_id_unverified")
	}
	return c.ID, nil
}
func (m *Manager) verifyContainer(ctx context.Context, name, workspace string) error {
	_, e := m.verifyContainerID(ctx, name, workspace)
	return e
}
func (m *Manager) containerAction(ctx context.Context, name, verb string, max int) (Result, error) {
	id, e := m.verifyContainerID(ctx, name, "")
	if e != nil {
		return Result{}, e
	}
	name = id
	if verb == "logs" {
		return run(ctx, m.config.DockerPath, max, "logs", "--tail=200", name)
	}
	if verb != "status" {
		if !slices.Contains([]string{"start", "stop", "restart"}, verb) {
			return Result{}, errors.New("container_action_denied")
		}
		if out, e := run(ctx, m.config.DockerPath, max, verb, name); e != nil {
			return out, e
		}
	}
	out, e := run(ctx, m.config.DockerPath, max, "inspect", "--format={{json .State}}", name)
	if e != nil {
		return out, e
	}
	var state struct {
		Running  bool
		Status   string
		ExitCode int
	}
	if e = json.Unmarshal([]byte(out.Output), &state); e != nil {
		return out, e
	}
	out.Status = "stopped"
	if state.Running {
		out.Status = "running"
	}
	out.ExitCode = state.ExitCode
	return out, nil
}
func (m *Manager) environment(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID      string `json:"operation_id"`
		GrantID          string `json:"grant_id"`
		ExpectedRevision int    `json:"expected_revision"`
	}
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	id := r.PathValue("id")
	b, e := m.binding(id)
	verb := r.PathValue("verb")
	if e != nil || b.Type != "container" || b.EnvironmentID == nil || b.RuntimeID == "" || !slices.Contains([]string{"restart", "rebuild", "remove"}, verb) || runtime.GOOS != "linux" || !slices.Contains(b.EnvironmentGrantIDs, q.GrantID) {
		http.Error(w, "environment_unavailable", 403)
		return
	}
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		var out Result
		e := m.guard(id, func() error {
			var x error
			b, x = m.binding(id)
			if x != nil {
				return x
			}
			if q.ExpectedRevision != b.Revision {
				return errors.New("file_conflict")
			}
			if snap, x := m.roots[id].Capture(); x != nil {
				return x
			} else if len(snap.Exclusions) > 0 {
				return errors.New("environment_project_contains_unverified_special_files")
			}
			runtimeID, x := m.verifyContainerID(r.Context(), b.RuntimeID, id)
			if x != nil {
				return x
			}
			b.RuntimeID = runtimeID
			switch verb {
			case "restart":
				var x error
				out, x = run(r.Context(), m.config.DockerPath, 1<<20, "restart", b.RuntimeID)
				return x
			case "remove":
				var x error
				out, x = run(r.Context(), m.config.DockerPath, 1<<20, "rm", "--force", b.RuntimeID)
				return x
			default:
				var x error
				next := b
				var nonce [16]byte
				if _, x = rand.Read(nonce[:]); x != nil {
					return x
				}
				nonce[6] = (nonce[6] & 15) | 64
				nonce[8] = (nonce[8] & 63) | 128
				envID := fmt.Sprintf("%x-%x-%x-%x-%x", nonce[0:4], nonce[4:6], nonce[6:8], nonce[8:10], nonce[10:16])
				next.EnvironmentID = &envID
				generation := 1
				if b.EnvironmentGeneration != nil {
					generation = *b.EnvironmentGeneration + 1
				}
				next.EnvironmentGeneration = &generation
				next.Revision++
				next.RuntimeID = "homelab-env-" + envID
				out, x = m.rebuild(r.Context(), b, next)
				if x != nil {
					return x
				}
				captured, x := m.verifyContainerID(r.Context(), next.RuntimeID, id)
				if x != nil {
					return x
				}
				next.RuntimeID = captured
				if x = m.saveBinding(next); x != nil {
					return x
				}
				b = next
				return nil
			}
		})
		return map[string]any{"result": out, "files_preserved": true, "binding": b}, e
	}))
}
func (m *Manager) deleteData(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID   string `json:"operation_id"`
		CanonicalRoot string `json:"canonical_root"`
		GrantID       string `json:"grant_id"`
	}
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	id := r.PathValue("id")
	b, e := m.binding(id)
	if e != nil || !b.Writable || b.DeletionGrantID == "" || q.GrantID != b.DeletionGrantID || q.CanonicalRoot != b.CanonicalRoot {
		http.Error(w, "exact_root_ownership_grant_required", 403)
		return
	}
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		var ids []string
		e := m.guard(id, func() error {
			b, e = m.binding(id)
			if e != nil {
				return e
			}
			s, e := m.roots[id].Capture()
			if e != nil {
				return e
			}
			if len(s.Exclusions) > 0 {
				return errors.New("delete_capture_incomplete")
			}
			if e = m.checkpoint(id, q.OperationID, s); e != nil {
				return e
			}
			for _, f := range s.Files {
				if f.Entry.Kind != "file" {
					continue
				}
				v, e := m.roots[id].Quarantine(f.Entry.Path, *f.Entry.SHA256)
				if e != nil {
					return e
				}
				ids = append(ids, v.ID)
			}
			b.State = "archived"
			b.Revision++
			return m.saveBinding(b)
		})
		if e != nil && len(ids) > 0 {
			e = fmt.Errorf("delete_partial: %s", e.Error())
		}
		return map[string]any{"quarantine_ids": ids, "root_preserved": true, "recoverable": true, "binding": b}, e
	}))
}
func (m *Manager) backup(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID string `json:"operation_id"`
		WorkspaceID string `json:"workspace_id"`
	}
	body, e := decode(w, r, &q)
	if e != nil {
		http.Error(w, "invalid_request", 400)
		return
	}
	if _, e = m.binding(q.WorkspaceID); e != nil {
		http.Error(w, "workspace_denied", 403)
		return
	}
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		var s files.Snapshot
		e := m.guard(q.WorkspaceID, func() error { var x error; s, x = m.roots[q.WorkspaceID].Capture(); return x })
		return map[string]any{"workspace_id": q.WorkspaceID, "machine_id": m.config.MachineID, "boot_id": m.config.BootID, "captured_at": time.Now().UTC(), "snapshot": s, "manifest_hash": files.ManifestHash(s), "consistency": "best_effort"}, e
	}))
}

var pinnedImage = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$`)
var nonrootUser = regexp.MustCompile(`^[1-9][0-9]*:[1-9][0-9]*$`)

func (m *Manager) rebuild(ctx context.Context, b WorkspaceBinding, next WorkspaceBinding) (Result, error) {
	if !pinnedImage.MatchString(b.ImageDigest) || !nonrootUser.MatchString(b.ContainerUser) || b.CPUs <= 0 || b.CPUs > 64 || b.MemoryBytes < 16<<20 || b.PidsLimit < 1 || b.PidsLimit > 4096 || len(b.Command) == 0 || !strings.HasPrefix(b.Command[0], "/") || strings.ContainsAny(b.CanonicalRoot, ",\r\n") || b.RuntimePath != "/workspace/project" {
		return Result{}, errors.New("environment_template_unverified")
	}
	// Validate image availability before removing the old dedicated environment.
	if out, e := run(ctx, m.config.DockerPath, 1<<20, "image", "inspect", b.ImageDigest); e != nil {
		return out, e
	}
	if out, e := run(ctx, m.config.DockerPath, 1<<20, "rm", "--force", b.RuntimeID); e != nil {
		return out, e
	}
	args := []string{"create", "--name", next.RuntimeID, "--label", "homelab.machine_id=" + m.config.MachineID, "--label", "homelab.workspace_id=" + b.WorkspaceID, "--user", b.ContainerUser, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=none", "--cpus", strconv.FormatFloat(b.CPUs, 'f', -1, 64), "--memory", strconv.FormatInt(b.MemoryBytes, 10), "--pids-limit", strconv.Itoa(b.PidsLimit), "--mount", "type=bind,source=" + b.CanonicalRoot + ",target=/workspace/project", "--workdir", "/workspace/project", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", b.ImageDigest}
	args = append(args, b.Command...)
	if out, e := run(ctx, m.config.DockerPath, 1<<20, args...); e != nil {
		return out, e
	}
	return run(ctx, m.config.DockerPath, 1<<20, "start", next.RuntimeID)
}

func (m *Manager) putFile(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID    string          `json:"operation_id"`
		Path           string          `json:"path"`
		ContentBase64  string          `json:"content_base64"`
		ExpectedSHA256 *string         `json:"expected_sha256"`
		GrantID        string          `json:"grant_id,omitempty"`
		Grant          *protocol.Grant `json:"grant,omitempty"`
		Fence          int64           `json:"fence,omitempty"`
		DispatchEpoch  string          `json:"dispatch_epoch,omitempty"`
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
	data, e := base64.StdEncoding.DecodeString(q.ContentBase64)
	if e != nil || len(data) > files.MaxFileBytes {
		http.Error(w, "invalid_content", 400)
		return
	}
	write(w, m.mutate(q.OperationID, r.URL.Path, body, func() (any, error) {
		var hash string
		e := m.guard(id, func() error {
			var x error
			current, x := m.binding(id)
			if x != nil || !current.Writable || current.State != "active" {
				return errors.New("workspace_denied")
			}
			hash, x = m.roots[id].WriteWithQuota(q.Path, data, q.ExpectedSHA256, b.QuotaBytes)
			return x
		})
		return map[string]any{"sha256": hash, "size_bytes": len(data)}, e
	}))
}

func (m *Manager) checkFence(job string, fence int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.checkFenceLocked(job, fence)
}
func (m *Manager) checkFenceLocked(job string, fence int64) error {
	var prior int64
	e := m.db.QueryRow(`SELECT fence FROM hostops_fences WHERE operation_id=?`, job).Scan(&prior)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	if fence < prior {
		return errors.New("stale_fence")
	}
	_, e = m.db.Exec(`INSERT INTO hostops_fences(operation_id,fence) VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET fence=MAX(fence,excluded.fence)`, job, fence)
	return e
}

func (m *Manager) mkdir(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID string `json:"operation_id"`
		Path        string `json:"path"`
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
		return nil, m.guard(id, func() error {
			if e := m.activeWritable(id); e != nil {
				return e
			}
			return m.roots[id].Mkdir(q.Path)
		})
	}))
}
func (m *Manager) rename(w http.ResponseWriter, r *http.Request) {
	var q struct {
		OperationID     string `json:"operation_id"`
		SourcePath      string `json:"source_path"`
		DestinationPath string `json:"destination_path"`
		ExpectedSHA256  string `json:"expected_sha256"`
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
		return map[string]any{"source_path": q.SourcePath, "destination_path": q.DestinationPath}, m.guard(id, func() error {
			if e := m.activeWritable(id); e != nil {
				return e
			}
			return m.roots[id].RenameFile(q.SourcePath, q.DestinationPath, q.ExpectedSHA256)
		})
	}))
}
func (m *Manager) listQuarantine(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, e := m.binding(id); e != nil {
		http.Error(w, "workspace_denied", 403)
		return
	}
	items, e := m.roots[id].ListQuarantine()
	if e != nil {
		http.Error(w, e.Error(), 500)
		return
	}
	write(w, map[string]any{"items": items})
}

func (m *Manager) activeWritable(id string) error {
	b, e := m.binding(id)
	if e != nil || !b.Writable || b.State != "active" {
		return errors.New("workspace_denied")
	}
	return nil
}
