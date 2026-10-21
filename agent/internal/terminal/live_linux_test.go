//go:build linux

package terminal

import (
	"context"
	"fmt"
	"homelab/agent/internal/native"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLiveRestrictedWorkspaceTerminal(t *testing.T) {
	if os.Getenv("HOMELAB_NATIVE_LIVE") != "1" {
		t.Skip("explicit disposable systemd runtime authorization required")
	}
	agent := os.Getenv("HOMELAB_NATIVE_AGENT_EXE")
	if agent == "" {
		t.Skip("trusted identity-probe agent executable required")
	}
	if os.Geteuid() != 0 {
		t.Fatal("existing transient-unit supervisor authority required")
	}
	base, e := os.MkdirTemp("/srv", "homelab-terminal-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(base)
	os.Chmod(base, 0755)
	nc := native.Config{Root: filepath.Join(base, "project"), Scratch: filepath.Join(base, "scratch"), SpoolDir: filepath.Join(base, "spool"), UID: 65534, GID: 65534, ACLReviewed: true, SystemdRun: "/usr/bin/systemd-run", Systemctl: "/usr/bin/systemctl"}
	for _, p := range []string{nc.Root, nc.Scratch, nc.SpoolDir} {
		if e = os.Mkdir(p, 0700); e != nil {
			t.Fatal(e)
		}
	}
	for _, p := range []string{nc.Root, nc.Scratch} {
		if e = os.Chown(p, 65534, 65534); e != nil {
			t.Fatal(e)
		}
	}
	defer func() {
		entries, _ := os.ReadDir(nc.SpoolDir)
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".log") {
				id := strings.TrimSuffix(entry.Name(), ".log")
				exec.Command("/usr/bin/systemctl", "stop", "homelab-"+id+".service").Run()
				exec.Command("/usr/bin/systemctl", "reset-failed", "homelab-"+id+".service").Run()
			}
		}
	}()
	runner, e := native.New(nc)
	if e != nil {
		t.Fatal(e)
	}
	sentinel := filepath.Join(nc.SpoolDir, "identity-denied-sentinel")
	if e = os.WriteFile(sentinel, []byte("disposable nonsecret access sentinel"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = runner.Verify(context.Background(), agent, sentinel); e != nil {
		t.Fatal(e)
	}
	acquired, released := 0, 0
	c := Config{Native: nc, Shell: "/usr/bin/dash", Args: []string{"-i"}, NetworkPolicy: "none", Limits: native.Limits{TimeoutSeconds: 30, MaxOutputBytes: 8192, MemoryBytes: 64 << 20, Pids: 16, CPUPercent: 25}, DataDir: filepath.Join(nc.SpoolDir, "terminals"), GraceSeconds: 10, IdleSeconds: 30, ReplayBytes: 8192, Acquire: func(Spec) error { acquired++; return nil }, Release: func(Record) error { released++; return nil }}
	m, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	spec := request(t, fmt.Sprintf("terminal-live-%d", time.Now().UnixNano()))
	rec, e := m.Start(context.Background(), spec)
	if e != nil {
		t.Fatal(e)
	}
	if acquired != 1 || released != 0 || rec.State != "detached" {
		t.Fatal("incorrect initial writer/client lifecycle", rec.State, acquired, released)
	}
	if _, e = m.AttachClient(context.Background(), rec.ID, "client-one", 0, 8192); e != nil {
		t.Fatal(e)
	}
	if e = m.InputClient(rec.ID, "client-one", []byte("id\nstty size\n")); e != nil {
		t.Fatal(e)
	}
	output := ""
	after := int64(0)
	wait := func(marker string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !strings.Contains(output, marker) && time.Now().Before(deadline) {
			o, e := m.Read(context.Background(), rec.ID, after, 8192)
			if e != nil {
				t.Fatal(e)
			}
			output += string(o.Data)
			after = o.NextOffset
			time.Sleep(20 * time.Millisecond)
		}
		if !strings.Contains(output, marker) {
			t.Fatalf("actual console output missing %q: %q", marker, output)
		}
	}
	wait("uid=65534(nobody)")
	wait("24 80")
	if e = m.ResizeClient(rec.ID, "client-one", 100, 35); e != nil {
		t.Fatal(e)
	}
	m.InputClient(rec.ID, "client-one", []byte("stty size\n"))
	wait("35 100")
	if e = m.DetachClient(rec.ID, "client-one"); e != nil {
		t.Fatal(e)
	}
	if released != 0 {
		t.Fatal("detach released process writer")
	}
	if _, e = m.AttachClient(context.Background(), rec.ID, "client-two", after, 8192); e != nil {
		t.Fatal(e)
	}
	if e = m.DetachClient(rec.ID, "client-one"); e != nil {
		t.Fatal(e)
	}
	current, e := m.Inspect(context.Background(), rec.ID)
	if e != nil || current.ClientID != "client-two" || current.State != "running" || current.Native.InvocationID != rec.Native.InvocationID {
		t.Fatal("stale detach altered replacement console", current, e)
	}
	if e = m.InputClient(rec.ID, "client-one", []byte("echo unauthorized old client\n")); e == nil {
		t.Fatal("replaced client could send input")
	}
	if _, e = m.Cancel(context.Background(), rec.ID); e != nil {
		t.Fatal(e)
	}
	if released != 1 {
		t.Fatal("confirmed actual containment exit did not release writer", released)
	}
	t.Logf("actual restricted terminal stable session=%s invocation=%s writer acquired once/held across detach+replacement/released after OSstop; UID,PTYresize,replay,input and stale-client guard passed", rec.ID, rec.Native.InvocationID)
}
