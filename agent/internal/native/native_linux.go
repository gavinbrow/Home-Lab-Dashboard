//go:build linux

package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Runner struct{ config Config }

func New(c Config) (*Runner, error) {
	if e := validateConfig(c); e != nil {
		return nil, e
	}
	if c.UID == 0 || c.GID == 0 || int(c.UID) == os.Getuid() {
		return nil, errors.New("dedicated_nonroot_uid_gid_required")
	}
	if c.SystemdRun != "/usr/bin/systemd-run" || c.Systemctl != "/usr/bin/systemctl" {
		return nil, errors.New("reviewed_systemd_paths_required")
	}
	controllers, e := os.ReadFile("/sys/fs/cgroup/cgroup.controllers")
	if e != nil {
		return nil, errors.New("native_cgroup_v2_controllers_required")
	}
	for _, controller := range []string{"cpu", "memory", "pids"} {
		if !strings.Contains(" "+strings.TrimSpace(string(controllers))+" ", " "+controller+" ") {
			return nil, errors.New("native_required_cgroup_controller_unavailable")
		}
	}
	account, e := user.LookupId(strconv.FormatUint(uint64(c.UID), 10))
	if e != nil || account.Gid != strconv.FormatUint(uint64(c.GID), 10) {
		return nil, errors.New("existing_dedicated_uid_gid_required")
	}
	groups, e := account.GroupIds()
	if e != nil {
		return nil, e
	}
	for _, g := range groups {
		if g != account.Gid {
			return nil, errors.New("execution_account_extra_groups_rejected")
		}
	}
	info, e := os.Stat(c.SpoolDir)
	if e != nil {
		return nil, e
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("native_spool_requires_private_supervisor_ownership")
	}
	// Numeric IDs are explicit; systemd never inherits the supervisor account.
	return &Runner{config: c}, nil
}
func (r *Runner) Validate(s Spec) error {
	if e := validate(r.config, s); e != nil {
		return e
	}
	for _, v := range append([]string{s.Command}, s.Args...) {
		if strings.ContainsAny(v, "%$") {
			return errors.New("systemd_argument_expansion_characters_unsupported")
		}
	}
	return nil
}
func (r *Runner) control(ctx context.Context, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, e := exec.CommandContext(ctx, r.config.Systemctl, args...).Output()
	if e != nil {
		return "", e
	}
	if len(out) > 65536 {
		return "", errors.New("systemd_response_too_large")
	}
	return string(out), nil
}
func (r *Runner) Launch(ctx context.Context, s Spec) (Record, error) {
	return r.launch(ctx, s, "")
}
func (r *Runner) launch(ctx context.Context, s Spec, tty string) (Record, error) {
	if e := r.Validate(s); e != nil {
		return Record{}, e
	}
	c := r.config
	rec := Record{ID: s.ID, ContainerID: "homelab-" + s.ID + ".service", Identity: fmt.Sprintf("%d:%d", c.UID, c.GID), OutputPath: filepath.Join(c.SpoolDir, s.ID+".log"), Deadline: time.Now().Add(time.Duration(s.Limits.TimeoutSeconds) * time.Second)}
	// Exclusive spool creation also rejects local duplicate launches. The caller
	// persists launching before entering here and must never retry ambiguous errors.
	f, e := os.OpenFile(rec.OutputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return Record{}, e
	}
	f.Close()
	args := []string{"--quiet", "--unit=" + rec.ContainerID, "--service-type=exec"}
	props := []string{"Description=homelab-operation-" + s.ID, "User=" + strconv.FormatUint(uint64(c.UID), 10), "Group=" + strconv.FormatUint(uint64(c.GID), 10), "SupplementaryGroups=", "WorkingDirectory=" + c.Root, "KillMode=control-group", "TimeoutStopSec=5s", "SendSIGKILL=yes", "RuntimeMaxSec=" + strconv.Itoa(s.Limits.TimeoutSeconds) + "s", "RemainAfterExit=yes", "Restart=no", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "RestrictSUIDSGID=yes", "RestrictNamespaces=yes", "CapabilityBoundingSet=", "AmbientCapabilities=", "ReadWritePaths=" + quoteSystemd(c.Root) + " " + quoteSystemd(c.Scratch), "StandardInput=null", "StandardOutput=append:" + rec.OutputPath, "StandardError=inherit", "MemoryMax=" + strconv.FormatInt(s.Limits.MemoryBytes, 10), "TasksMax=" + strconv.Itoa(s.Limits.Pids), "CPUQuota=" + strconv.Itoa(s.Limits.CPUPercent) + "%", "LimitFSIZE=" + strconv.FormatInt(s.Limits.MaxOutputBytes, 10)}
	if s.NetworkPolicy == "none" {
		props = append(props, "PrivateNetwork=yes")
	}
	if tty != "" {
		// A host PTY cannot be reached inside PrivateDevices' separate devpts.
		// Keep the existing UID/mount/capability boundary and permit this one slave
		// through an explicit device cgroup policy, never all host devices.
		props = append(props, "PrivateDevices=no", "DevicePolicy=closed", "DeviceAllow="+tty+" rw", "StandardInput=tty", "StandardOutput=tty", "StandardError=tty", "TTYPath="+tty, "TTYReset=yes", "TTYVHangup=yes", "Environment=TERM=xterm-256color HOME="+quoteSystemd(c.Scratch)+" TMPDIR="+quoteSystemd(c.Scratch))
		// PTY bytes are bounded by the terminal manager's replay/transcript
		// policy. A stdout quota must not become an unrelated project-file cap.
		props = append(props, "LimitFSIZE=infinity")
	}
	for _, p := range props {
		args = append(args, "--property="+p)
	}
	args = append(args, "--property=ExitType=cgroup")
	args = append(args, "--property=LimitCORE=0")
	args = append(args, "--", s.Command)
	args = append(args, s.Args...)
	launchCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if _, e = exec.CommandContext(launchCtx, c.SystemdRun, args...).Output(); e != nil {
		detail := "systemd_start_failed"
		if exit, ok := e.(*exec.ExitError); ok {
			detail = string(exit.Stderr[:min(len(exit.Stderr), 2048)])
		}
		return Record{}, fmt.Errorf("%w: %s", ErrUnknown, strings.TrimSpace(detail))
	}
	// systemd owns the cgroup and deadline after this call returns. Neither this
	// context nor the connection agent is the service's lifetime parent.
	out, e := r.control(ctx, "show", rec.ContainerID, "--property=InvocationID", "--value")
	if e != nil {
		return Record{}, ErrUnknown
	}
	rec.InvocationID = strings.TrimSpace(out)
	if len(rec.InvocationID) != 32 {
		return Record{}, ErrUnknown
	}
	return rec, nil
}
func quoteSystemd(p string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(p, `\`, `\\`), `"`, `\"`) + `"`
}
func (r *Runner) Inspect(ctx context.Context, rec Record) (Status, error) {
	return r.inspect(ctx, rec, 3)
}
func (r *Runner) inspect(ctx context.Context, rec Record, retries int) (Status, error) {
	if !validID.MatchString(rec.ID) || rec.ContainerID != "homelab-"+rec.ID+".service" || len(rec.InvocationID) != 32 {
		return Status{}, ErrUnknown
	}
	out, e := r.control(ctx, "show", rec.ContainerID, "--property=LoadState,ActiveState,SubState,InvocationID,User,Group,MainPID,ExecMainStatus,Description,Result")
	if e != nil {
		return Status{}, e
	}
	m := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		p := strings.SplitN(line, "=", 2)
		if len(p) == 2 {
			m[p[0]] = p[1]
		}
	}
	if m["LoadState"] == "not-found" {
		b, e := os.ReadFile(filepath.Join(r.config.SpoolDir, rec.ID+".result.json"))
		if e == nil {
			var saved struct {
				Record Record
				Status Status
			}
			if json.Unmarshal(b, &saved) == nil && saved.Record.ID == rec.ID && saved.Record.ContainerID == rec.ContainerID && saved.Record.Identity == rec.Identity && saved.Record.InvocationID == rec.InvocationID {
				return saved.Status, nil
			}
			return Status{}, ErrUnknown
		}
		return Status{}, nil
	}
	identity := m["User"] + ":" + m["Group"]
	if m["InvocationID"] != rec.InvocationID || m["Description"] != "homelab-operation-"+rec.ID || identity != rec.Identity || identity != fmt.Sprintf("%d:%d", r.config.UID, r.config.GID) {
		return Status{}, ErrUnknown
	}
	running := m["SubState"] == "running" || m["ActiveState"] == "activating" || m["ActiveState"] == "deactivating"
	if pid := m["MainPID"]; running && pid != "0" && pid != "" {
		// Verify the actual running credentials, including effective and saved IDs.
		b, e := os.ReadFile("/proc/" + pid + "/status")
		if e != nil {
			// MainPID can exit between the systemd snapshot and /proc open.
			// Settle only through a new verified result for the same invocation.
			if os.IsNotExist(e) && retries > 0 {
				select {
				case <-ctx.Done():
					return Status{}, ctx.Err()
				case <-time.After(2 * time.Millisecond):
				}
				return r.inspect(ctx, rec, retries-1)
			}
			return Status{}, ErrUnknown
		}
		found := false
		gidFound := false
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "Uid:") || strings.HasPrefix(line, "Gid:") {
				expected := m["User"]
				if strings.HasPrefix(line, "Gid:") {
					expected = m["Group"]
					gidFound = true
				}
				parts := strings.Fields(line)
				if len(parts) != 5 {
					return Status{}, ErrUnknown
				}
				for _, v := range parts[1:] {
					if v != expected {
						return Status{}, ErrUnknown
					}
				}
				if strings.HasPrefix(line, "Uid:") {
					found = true
				}
			}
			if strings.HasPrefix(line, "Groups:") {
				for _, g := range strings.Fields(line)[1:] {
					if g != m["Group"] {
						return Status{}, ErrUnknown
					}
				}
			}
		}
		if !found || !gidFound {
			return Status{}, ErrUnknown
		}
	}
	code, e := strconv.Atoi(m["ExecMainStatus"])
	if e != nil {
		return Status{}, ErrUnknown
	}
	return Status{Exists: true, Running: running, ExitCode: code, IdentityVerified: true, Reason: m["Result"]}, nil
}
func (r *Runner) Cancel(ctx context.Context, rec Record) error {
	s, e := r.Inspect(ctx, rec)
	if e != nil {
		return e
	}
	if !s.Exists {
		return ErrUnknown
	}
	if !s.Running {
		return nil
	}
	if _, e = r.control(ctx, "stop", rec.ContainerID); e != nil {
		return e
	}
	s, e = r.Inspect(ctx, rec)
	if e != nil {
		return e
	}
	if s.Running {
		return errors.New("native_cancellation_pending")
	}
	if !s.Exists {
		// A successful synchronous systemctl stop waits for KillMode=control-group
		// termination. An inactive transient unit may already be garbage-collected.
		// Persist that confirmed result before returning to the supervisor journal.
		s = Status{Exists: true, IdentityVerified: true, ExitCode: 143, Reason: "cancelled_containment_stopped"}
		b, e := json.Marshal(struct {
			Record Record
			Status Status
		}{rec, s})
		if e != nil {
			return e
		}
		path := filepath.Join(r.config.SpoolDir, rec.ID+".result.json")
		f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		if _, e = f.Write(b); e == nil {
			e = f.Sync()
		}
		f.Close()
		if e != nil {
			return e
		}
		dir, e := os.Open(r.config.SpoolDir)
		if e != nil {
			return e
		}
		e = dir.Sync()
		dir.Close()
		if e != nil {
			return e
		}
	}
	return nil
}
