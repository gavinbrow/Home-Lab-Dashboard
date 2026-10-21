//go:build linux

package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var containerUser = regexp.MustCompile(`^[1-9][0-9]*:[1-9][0-9]*$`)
var containerID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var containerRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$`)
var imageRef = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9./:_-]*@sha256:[a-f0-9]{64}$`)

type containerBackend struct{ config ContainerConfig }
type containerStopState struct {
	Config ContainerConfig
	Record native.Record
}
type containerStopResult struct {
	Record native.Record
	Status native.Status
}
type limitedOutput struct {
	data     []byte
	limit    int
	overflow bool
}

func (w *limitedOutput) Write(p []byte) (int, error) {
	n := len(p)
	room := w.limit - len(w.data)
	if len(p) > room {
		w.overflow = true
	}
	if room > 0 {
		w.data = append(w.data, p[:min(len(p), room)]...)
	}
	return n, nil
}

type containerSnapshot struct {
	ID    string `json:"Id"`
	State struct {
		Running   bool
		StartedAt string
		ExitCode  int
	}
	Config struct {
		User, Image string
		Labels      map[string]string
	}
	Mounts []struct {
		Source, Destination, Type string
		RW                        bool
	}
	HostConfig struct {
		Privileged, ReadonlyRootfs                                       bool
		CapAdd, CapDrop, SecurityOpt                                     []string
		NetworkMode, PidMode, IpcMode, UTSMode, UsernsMode, CgroupnsMode string
		Devices                                                          []json.RawMessage
		DeviceRequests                                                   []json.RawMessage
		Memory, NanoCpus                                                 int64
		PidsLimit                                                        *int64
	}
}

func newContainerBackend(c ContainerConfig) (backend, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("terminal_container_fixed_control_requires_configured_privileged_supervisor")
	}
	if c.DockerPath != "/usr/bin/docker" || c.SystemdRun != "/usr/bin/systemd-run" || c.Systemctl != "/usr/bin/systemctl" || !containerRef.MatchString(c.RuntimeID) || !containerUser.MatchString(c.User) || !imageRef.MatchString(c.ImageDigest) || c.Generation < 1 || !protocolID(c.MachineID) || !protocolID(c.WorkspaceID) || !protocolID(c.EnvironmentID) || c.CPUs <= 0 || c.CPUs > 64 || c.MemoryBytes < 16<<20 || c.PidsLimit < 1 || c.PidsLimit > 4096 {
		return nil, errors.New("terminal_container_policy_unverified")
	}
	if c.IdentityProbe == "" {
		c.IdentityProbe = "/usr/bin/id"
	}
	resolvedHelper, e := filepath.EvalSymlinks(c.HelperPath)
	if e != nil || resolvedHelper != c.HelperPath || !filepath.IsAbs(c.HelperPath) || strings.ContainsAny(c.HelperPath, "\r\n%$") {
		return nil, errors.New("terminal_container_trusted_helper_required")
	}
	relHelper, e := filepath.Rel(c.Root, c.HelperPath)
	if e != nil || filepath.IsLocal(relHelper) {
		return nil, errors.New("terminal_container_helper_outside_project_required")
	}
	if c.IdentityProbe != "/usr/bin/id" && c.IdentityProbe != "/bin/id" {
		return nil, errors.New("terminal_container_identity_probe_unreviewed")
	}
	for _, p := range []string{c.Root, c.SpoolDir} {
		if strings.ContainsAny(p, "\x00\r\n%$") {
			return nil, errors.New("terminal_container_path_expansion_denied")
		}
		resolved, e := filepath.EvalSymlinks(p)
		if e != nil || resolved != p || !filepath.IsAbs(p) {
			return nil, errors.New("terminal_container_canonical_roots_required")
		}
	}
	rel, e := filepath.Rel(c.Root, c.SpoolDir)
	if e != nil || filepath.IsLocal(rel) {
		return nil, errors.New("terminal_container_spool_must_be_protected")
	}
	info, e := os.Stat(c.SpoolDir)
	if e != nil {
		return nil, e
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("terminal_container_private_spool_required")
	}
	return &containerBackend{config: c}, nil
}
func protocolID(s string) bool {
	if len(s) < 1 || len(s) > 128 {
		return false
	}
	for _, ch := range s {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return false
		}
	}
	return true
}
func (b *containerBackend) run(ctx context.Context, path string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if path == b.config.DockerPath {
		args = append([]string{"--host=unix:///var/run/docker.sock", "--config=/nonexistent"}, args...)
	}
	w := &limitedOutput{limit: 1 << 20}
	command := exec.CommandContext(ctx, path, args...)
	command.Stdout = w
	e := command.Run()
	if w.overflow {
		return nil, errors.New("terminal_container_response_exceeded")
	}
	return w.data, e
}
func (b *containerBackend) snapshot(ctx context.Context, ref string) (containerSnapshot, error) {
	out, e := b.run(ctx, b.config.DockerPath, "inspect", ref)
	if e != nil {
		return containerSnapshot{}, e
	}
	var items []containerSnapshot
	if e = json.Unmarshal(out, &items); e != nil || len(items) != 1 {
		return containerSnapshot{}, errors.New("terminal_container_inspect_invalid")
	}
	return b.verifySnapshot(items[0])
}
func (b *containerBackend) verifySnapshot(v containerSnapshot) (containerSnapshot, error) {
	c := b.config
	for _, mode := range []string{v.HostConfig.PidMode, v.HostConfig.IpcMode, v.HostConfig.UTSMode, v.HostConfig.UsernsMode, v.HostConfig.CgroupnsMode} {
		if mode != "" && mode != "private" {
			return containerSnapshot{}, errors.New("terminal_container_shared_namespace_denied")
		}
	}
	if !containerID.MatchString(v.ID) || v.Config.User != c.User || v.Config.Image != c.ImageDigest || v.Config.Labels["homelab.machine_id"] != c.MachineID || v.Config.Labels["homelab.workspace_id"] != c.WorkspaceID || v.HostConfig.Privileged || !v.HostConfig.ReadonlyRootfs || len(v.HostConfig.CapAdd) > 0 || !slices.Contains(v.HostConfig.CapDrop, "ALL") || v.HostConfig.NetworkMode != "none" || v.HostConfig.PidMode == "host" || v.HostConfig.IpcMode == "host" || v.HostConfig.UTSMode == "host" || v.HostConfig.UsernsMode == "host" || v.HostConfig.CgroupnsMode == "host" || len(v.HostConfig.Devices) > 0 || len(v.HostConfig.DeviceRequests) > 0 || v.HostConfig.Memory != c.MemoryBytes || v.HostConfig.NanoCpus != int64(c.CPUs*1e9) || v.HostConfig.PidsLimit == nil || *v.HostConfig.PidsLimit != int64(c.PidsLimit) {
		return containerSnapshot{}, errors.New("terminal_container_identity_or_isolation_mismatch")
	}
	for _, opt := range v.HostConfig.SecurityOpt {
		if strings.Contains(opt, "unconfined") {
			return containerSnapshot{}, errors.New("terminal_container_security_profile_unconfined")
		}
	}
	if !protocol.DockerNoNewPrivilegesEnabled(v.HostConfig.SecurityOpt) {
		return containerSnapshot{}, errors.New("terminal_container_no_new_privileges_required")
	}
	bind := false
	for _, mount := range v.Mounts {
		if mount.Type == "tmpfs" {
			if mount.Destination != "/tmp" {
				return containerSnapshot{}, errors.New("terminal_container_extra_tmpfs_denied")
			}
			continue
		}
		if mount.Type != "bind" || mount.Source != c.Root || mount.Destination != "/workspace/project" || !mount.RW {
			return containerSnapshot{}, errors.New("terminal_container_extra_or_wrong_mount")
		}
		bind = true
	}
	if !bind {
		return containerSnapshot{}, errors.New("terminal_container_project_bind_missing")
	}
	return v, nil
}
func (b *containerBackend) ValidProof() (native.Proof, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	v, e := b.snapshot(ctx, b.config.RuntimeID)
	if e != nil || !v.State.Running {
		return native.Proof{}, errors.New("terminal_container_runtime_not_verified_running")
	}
	ids := strings.Split(b.config.User, ":")
	for i, flag := range []string{"-u", "-g"} {
		out, e := b.run(ctx, b.config.DockerPath, "exec", "--user", b.config.User, "--workdir", "/workspace/project", v.ID, b.config.IdentityProbe, flag)
		if e != nil || strings.TrimSpace(string(out)) != ids[i] {
			return native.Proof{}, errors.New("terminal_container_actual_uid_gid_unverified")
		}
	}
	return native.Proof{Verified: true, Identity: b.config.User, ObservedAt: time.Now().UTC()}, nil
}
func (b *containerBackend) LaunchTerminal(ctx context.Context, s native.Spec, cols, rows uint16) (native.Record, native.Terminal, error) {
	if e := b.Validate(s); e != nil {
		return native.Record{}, nil, e
	}
	if !dimensions(cols, rows) {
		return native.Record{}, nil, errors.New("terminal_container_spec_denied")
	}
	snapshot, e := b.snapshot(ctx, b.config.RuntimeID)
	if e != nil || !snapshot.State.Running {
		return native.Record{}, nil, errors.New("terminal_container_runtime_changed_before_launch")
	}
	rec := native.Record{ID: s.ID, ContainerID: snapshot.ID, InvocationID: snapshot.State.StartedAt, Identity: b.config.User, OutputPath: filepath.Join(b.config.SpoolDir, s.ID+".log"), Deadline: time.Now().Add(time.Duration(s.Limits.TimeoutSeconds) * time.Second)}
	f, e := os.OpenFile(rec.OutputPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return native.Record{}, nil, e
	}
	f.Close()
	statePath := filepath.Join(b.config.SpoolDir, s.ID+".container.json")
	state, e := json.Marshal(containerStopState{Config: b.config, Record: rec})
	if e != nil {
		return native.Record{}, nil, e
	}
	stateFile, e := os.OpenFile(statePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return native.Record{}, nil, e
	}
	if _, e = stateFile.Write(state); e == nil {
		e = stateFile.Sync()
	}
	stateFile.Close()
	if e != nil {
		return native.Record{}, nil, e
	}
	console, slave, release, e := containerPTY(cols, rows)
	if e != nil {
		return native.Record{}, nil, e
	}
	defer release()
	success := false
	defer func() {
		if !success {
			console.Close()
		}
	}()
	unit := "homelab-terminal-" + s.ID + ".service"
	props := []string{"Description=homelab-terminal-" + s.ID, "Type=exec", "RemainAfterExit=yes", "RuntimeMaxSec=" + strconv.Itoa(s.Limits.TimeoutSeconds) + "s", "TimeoutStopSec=15s", "KillMode=control-group", "SendSIGKILL=yes", "NoNewPrivileges=yes", "PrivateTmp=yes", "ProtectHome=yes", "ProtectSystem=strict", "CapabilityBoundingSet=", "StandardInput=tty", "StandardOutput=tty", "StandardError=tty", "TTYPath=" + slave, "TTYReset=yes", "TTYVHangup=yes", "LimitCORE=0", "Environment=TERM=xterm-256color", "ExecStopPost=" + unitQuote(b.config.HelperPath) + " terminal-container-stop --state " + unitQuote(statePath)}
	// Only the fixed Docker CLI/helper executes in this host unit. Project code
	// runs in the already isolated container. Keep approved existing roots/state
	// visible to the stop helper without giving it any writable host mounts.
	props = append(props, "PrivateTmp=no", "ProtectHome=read-only")
	props = append(props, "ReadWritePaths="+unitQuote(b.config.SpoolDir))
	args := []string{"--quiet", "--unit=" + unit}
	props = append(props, "RemainAfterExit=no")
	for _, p := range props {
		args = append(args, "--property="+p)
	}
	args = append(args, "--", b.config.DockerPath, "--host=unix:///var/run/docker.sock", "--config=/nonexistent", "exec", "--interactive", "--tty", "--user", b.config.User, "--workdir", "/workspace/project", "--env", "TERM=xterm-256color", snapshot.ID, s.Command)
	args = append(args, s.Args...)
	if _, e = b.run(ctx, b.config.SystemdRun, args...); e != nil {
		return native.Record{}, nil, native.ErrUnknown
	}
	success = true
	return rec, console, nil
}
func (b *containerBackend) Validate(s native.Spec) error {
	if !protocolID(s.ID) || !strings.HasPrefix(s.Command, "/") || s.Cwd != "/workspace/project" || len(s.Env) != 0 || s.NetworkPolicy != "none" {
		return errors.New("terminal_container_spec_denied")
	}
	for _, arg := range append([]string{s.Command}, s.Args...) {
		if strings.ContainsAny(arg, "\x00%$") {
			return errors.New("terminal_container_systemd_argument_expansion_denied")
		}
	}
	return nil
}
func (b *containerBackend) Inspect(ctx context.Context, rec native.Record) (native.Status, error) {
	if !protocolID(rec.ID) || !containerID.MatchString(rec.ContainerID) || rec.Identity != b.config.User || rec.InvocationID == "" {
		return native.Status{}, native.ErrUnknown
	}
	v, e := b.snapshot(ctx, rec.ContainerID)
	if e != nil {
		return native.Status{}, e
	}
	if v.ID != rec.ContainerID || v.State.StartedAt != rec.InvocationID {
		return native.Status{}, native.ErrUnknown
	}
	// The container entrypoint's exit is not the console's exit. A protected
	// ExecStopPost result can retain Docker exec's own service exit status.
	if !v.State.Running {
		data, e := os.ReadFile(filepath.Join(b.config.SpoolDir, rec.ID+".container-result.json"))
		if e == nil {
			var result containerStopResult
			if json.Unmarshal(data, &result) == nil && result.Record.ID == rec.ID && result.Record.ContainerID == rec.ContainerID && result.Record.InvocationID == rec.InvocationID && result.Record.Identity == rec.Identity {
				return result.Status, nil
			}
		}
		unit, _ := b.run(ctx, b.config.Systemctl, "show", "homelab-terminal-"+rec.ID+".service", "--property=ActiveState,Description")
		if strings.Contains(string(unit), "Description=homelab-terminal-"+rec.ID+"\n") && strings.Contains(string(unit), "ActiveState=deactivating\n") {
			return native.Status{Exists: true, Running: true, IdentityVerified: true, ExitCodeUnknown: true, Reason: "container_stopped_exec_result_flush_pending"}, nil
		}
	}
	return native.Status{Exists: true, Running: v.State.Running, ExitCodeUnknown: true, IdentityVerified: true, Reason: "dedicated_container_terminal_containment_shell_exit_unavailable"}, nil
}
func (b *containerBackend) Cancel(ctx context.Context, rec native.Record) error {
	status, e := b.Inspect(ctx, rec)
	if e != nil {
		return e
	}
	if !status.Running {
		return nil
	}
	if _, e = b.run(ctx, b.config.Systemctl, "stop", "homelab-terminal-"+rec.ID+".service"); e != nil {
		return e
	}
	status, e = b.Inspect(ctx, rec)
	if e != nil {
		return e
	}
	if status.Running {
		if _, e = b.run(ctx, b.config.DockerPath, "stop", "--time=5", rec.ContainerID); e != nil {
			return e
		}
		status, e = b.Inspect(ctx, rec)
		if e != nil {
			return e
		}
	}
	if status.Running {
		return errors.New("terminal_container_cancellation_pending")
	}
	return nil
}

type dockerPTY struct{ master *os.File }

func (t *dockerPTY) Read(b []byte) (int, error)  { return t.master.Read(b) }
func (t *dockerPTY) Write(b []byte) (int, error) { return t.master.Write(b) }
func (t *dockerPTY) Close() error                { return t.master.Close() }
func (t *dockerPTY) Resize(cols, rows uint16) error {
	if !dimensions(cols, rows) {
		return errors.New("terminal_invalid_dimensions")
	}
	return unix.IoctlSetWinsize(int(t.master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
}
func containerPTY(cols, rows uint16) (native.Terminal, string, func(), error) {
	fd, e := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if e != nil {
		return nil, "", nil, e
	}
	master := os.NewFile(uintptr(fd), "fixed-docker-helper-pty")
	fail := func(e error) (native.Terminal, string, func(), error) { master.Close(); return nil, "", nil, e }
	if e = unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); e != nil {
		return fail(e)
	}
	number, e := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if e != nil {
		return fail(e)
	}
	slavePath := fmt.Sprintf("/dev/pts/%d", number)
	slave, e := unix.Open(slavePath, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if e != nil {
		return fail(e)
	}
	t := &dockerPTY{master}
	if e = t.Resize(cols, rows); e != nil {
		unix.Close(slave)
		return fail(e)
	}
	return t, slavePath, func() { unix.Close(slave) }, nil
}

func unitQuote(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

// RunContainerStopHelper is a fixed privileged maintenance mode of the trusted
// agent executable. It never executes project code or accepts a caller command.
// Changed container start identity refuses termination of a replacement runtime.
func RunContainerStopHelper(statePath string) error {
	canonical, e := filepath.EvalSymlinks(statePath)
	if e != nil || canonical != statePath || !filepath.IsAbs(statePath) {
		return errors.New("terminal_container_stop_state_untrusted")
	}
	info, e := os.Stat(statePath)
	if e != nil {
		return e
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 || !info.Mode().IsRegular() || info.Size() > 65536 {
		return errors.New("terminal_container_stop_state_permissions_invalid")
	}
	data, e := os.ReadFile(statePath)
	if e != nil {
		return e
	}
	var state containerStopState
	if e = json.Unmarshal(data, &state); e != nil {
		return e
	}
	b, e := newContainerBackend(state.Config)
	if e != nil {
		return e
	}
	if !protocolID(state.Record.ID) || statePath != filepath.Join(state.Config.SpoolDir, state.Record.ID+".container.json") {
		return errors.New("terminal_container_stop_state_identity_mismatch")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	status, e := b.Inspect(ctx, state.Record)
	if e != nil {
		return e
	}
	if !status.Running {
		return nil
	}
	concrete := b.(*containerBackend)
	if _, e = concrete.run(ctx, state.Config.DockerPath, "stop", "--time=5", state.Record.ContainerID); e != nil {
		return e
	}
	verified, e := concrete.snapshot(ctx, state.Record.ContainerID)
	if e != nil {
		return e
	}
	if verified.ID != state.Record.ContainerID || verified.State.StartedAt != state.Record.InvocationID {
		return native.ErrUnknown
	}
	if verified.State.Running {
		return errors.New("terminal_container_stop_unconfirmed")
	}
	result := native.Status{Exists: true, IdentityVerified: true, ExitCodeUnknown: true, Reason: "container_stopped_shell_exit_unavailable"}
	if os.Getenv("EXIT_CODE") == "exited" {
		if code, e := strconv.Atoi(os.Getenv("EXIT_STATUS")); e == nil && code >= 0 && code <= 255 {
			result.ExitCode = code
			result.ExitCodeUnknown = false
			result.Reason = "container_shell_exited_environment_stopped"
		}
	}
	data, e = json.Marshal(containerStopResult{Record: state.Record, Status: result})
	if e != nil {
		return e
	}
	path := filepath.Join(state.Config.SpoolDir, state.Record.ID+".container-result.json")
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	closeError := f.Close()
	if e != nil {
		return e
	}
	if closeError != nil {
		return closeError
	}
	return syncDirectory(state.Config.SpoolDir)
}
