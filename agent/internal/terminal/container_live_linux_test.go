//go:build linux

package terminal

import (
	"context"
	"fmt"
	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLiveDedicatedContainerPTY(t *testing.T) {
	if os.Getenv("HOMELAB_TERMINAL_CONTAINER_LIVE") != "1" {
		t.Skip("explicit disposable Docker/systemd runtime authorization required")
	}
	helper := os.Getenv("HOMELAB_NATIVE_AGENT_EXE")
	if helper == "" {
		t.Skip("trusted fixed terminal-container-stop agent helper required")
	}
	if os.Geteuid() != 0 {
		t.Fatal("configured privileged fixed-container supervisor required")
	}
	base, e := os.MkdirTemp("/srv", "homelab-container-pty-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(base)
	os.Chmod(base, 0755)
	root, spool := filepath.Join(base, "project"), filepath.Join(base, "spool")
	os.Mkdir(root, 0700)
	os.Mkdir(spool, 0700)
	os.Chown(root, 65534, 65534)
	docker := func(args ...string) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		out, e := exec.CommandContext(ctx, "/usr/bin/docker", append([]string{"--host=unix:///var/run/docker.sock", "--config=/nonexistent"}, args...)...).CombinedOutput()
		if e != nil {
			t.Fatalf("disposable Docker fixture %v: %v %s", args, e, out)
		}
		return strings.TrimSpace(string(out))
	}
	image := "ubuntu@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac"
	name := fmt.Sprintf("homelab-terminal-live-%d", time.Now().UnixNano())
	id := docker("create", "--name", name, "--label", "homelab.machine_id=machine", "--label", "homelab.workspace_id=workspace", "--user", "65534:65534", "--cpus", "0.25", "--memory", "67108864", "--pids-limit", "32", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--network", "none", "--mount", "type=bind,source="+root+",target=/workspace/project", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", image, "/usr/bin/sleep", "300")
	defer exec.Command("/usr/bin/docker", "--host=unix:///var/run/docker.sock", "--config=/nonexistent", "rm", "--force", id).Run()
	docker("start", id)
	cc := &ContainerConfig{DockerPath: "/usr/bin/docker", HelperPath: helper, SystemdRun: "/usr/bin/systemd-run", Systemctl: "/usr/bin/systemctl", RuntimeID: name, MachineID: "machine", WorkspaceID: "workspace", EnvironmentID: "environment", Generation: 1, User: "65534:65534", Root: root, ImageDigest: image, SpoolDir: spool, CPUs: .25, MemoryBytes: 64 << 20, PidsLimit: 32}
	var acquired, released atomic.Int32
	c := Config{Container: cc, Shell: "/bin/sh", Args: []string{"-i"}, NetworkPolicy: "none", Limits: native.Limits{TimeoutSeconds: 30, MaxOutputBytes: 8192, MemoryBytes: 64 << 20, Pids: 32, CPUPercent: 25}, DataDir: filepath.Join(spool, "terminals"), GraceSeconds: 10, IdleSeconds: 30, ReplayBytes: 8192, Acquire: func(Spec) error { acquired.Add(1); return nil }, Release: func(Record) error { released.Add(1); return nil }}
	m, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	spec := request(t, fmt.Sprintf("container-pty-%d", time.Now().UnixNano()))
	spec.Request.EnvironmentID = &cc.EnvironmentID
	spec.Request.EnvironmentGeneration = &cc.Generation
	spec.Request.RequestHash, _ = protocol.Hash(spec.Request)
	rec, e := m.Start(context.Background(), spec)
	if e != nil {
		t.Fatal(e)
	}
	unit := "homelab-terminal-" + rec.ID + ".service"
	defer exec.Command("/usr/bin/systemctl", "reset-failed", unit).Run()
	defer exec.Command("/usr/bin/systemctl", "stop", unit).Run()
	if _, e = m.AttachClient(context.Background(), rec.ID, "container-client", 0, 8192); e != nil {
		t.Fatal(e)
	}
	if e = m.InputClient(rec.ID, "container-client", []byte("id\nstty size\n")); e != nil {
		t.Fatal(e)
	}
	output := ""
	offset := int64(0)
	wait := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !strings.Contains(output, marker) && time.Now().Before(deadline) {
			o, e := m.Read(context.Background(), rec.ID, offset, 8192)
			if e != nil {
				t.Fatal(e)
			}
			output += string(o.Data)
			offset = o.NextOffset
			time.Sleep(20 * time.Millisecond)
		}
		if !strings.Contains(output, marker) {
			t.Fatalf("actual container PTY output missing %q: %q", marker, output)
		}
	}
	wait("uid=65534(nobody)")
	wait("24 80")
	if e = m.ResizeClient(rec.ID, "container-client", 100, 35); e != nil {
		t.Fatal(e)
	}
	m.InputClient(rec.ID, "container-client", []byte("stty size\n"))
	wait("35 100")
	if e = m.DetachClient(rec.ID, "container-client"); e != nil {
		t.Fatal(e)
	}
	if released.Load() != 0 {
		t.Fatal("detach released container writer")
	}
	m.AttachClient(context.Background(), rec.ID, "reconnected-client", offset, 8192)
	if _, e = m.Cancel(context.Background(), rec.ID); e != nil {
		t.Fatal(e)
	}
	if released.Load() != 1 || acquired.Load() != 1 {
		t.Fatal("container writer lifetime not matched verified stop")
	}
	if got := docker("inspect", "--format", "{{.State.Running}}", id); got != "false" {
		t.Fatal("dedicated container still running after cancellation", got)
	}
	// A second explicit disposable session proves that shell exit status comes
	// from Docker exec, rather than the environment entrypoint killed by cleanup.
	docker("start", id)
	second := request(t, fmt.Sprintf("container-exit-%d", time.Now().UnixNano()))
	second.Request.EnvironmentID = &cc.EnvironmentID
	second.Request.EnvironmentGeneration = &cc.Generation
	second.Request.RequestHash, _ = protocol.Hash(second.Request)
	secondRecord, e := m.Start(context.Background(), second)
	if e != nil {
		t.Fatal(e)
	}
	secondUnit := "homelab-terminal-" + secondRecord.ID + ".service"
	defer exec.Command("/usr/bin/systemctl", "reset-failed", secondUnit).Run()
	defer exec.Command("/usr/bin/systemctl", "stop", secondUnit).Run()
	if _, e = m.AttachClient(context.Background(), secondRecord.ID, "exit-client", 0, 8192); e != nil {
		t.Fatal(e)
	}
	if e = m.InputClient(secondRecord.ID, "exit-client", []byte("exit 7\n")); e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		secondRecord, e = m.Inspect(context.Background(), secondRecord.ID)
		if e != nil {
			t.Fatal(e)
		}
		if secondRecord.State == "exited" {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if secondRecord.State != "exited" || secondRecord.ExitCode == nil || *secondRecord.ExitCode != 7 {
		t.Fatalf("actual shell exit7 not retained: %+v", secondRecord)
	}
	if released.Load() != 2 || acquired.Load() != 2 {
		t.Fatal("normal shell exit did not retain writer until environment stopped")
	}
	if got := docker("inspect", "--format", "{{.State.Running}}", id); got != "false" {
		t.Fatal("environment left running after normal shell exit", got)
	}
	t.Logf("actual normal container shell exit7 retained separately from container-entrypoint status, environment stopped, second writer released after proof")
	t.Logf("actual dedicated nonroot container PTY uid65534, initial+resize, reconnect original runtime=%s start=%s, stop-whole-environment verified before writerrelease", rec.Native.ContainerID, rec.Native.InvocationID)
}
