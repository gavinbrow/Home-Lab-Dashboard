//go:build linux

package supervisor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
)

// Opt-in proof uses an existing restricted account and one owned transient unit.
// No host clock, account, installed service or unrelated process is changed.
func TestLiveLegacyBootChangeRetainsActualNativeProcessWriter(t *testing.T) {
	if os.Getenv("HOMELAB_NATIVE_LIVE") != "1" {
		t.Skip("requires disposable systemd runtime authorization")
	}
	if os.Geteuid() != 0 {
		t.Fatal("configured systemd authority required")
	}
	base, err := os.MkdirTemp("/srv", "homelab-native-boot-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(base)
	if err = os.Chmod(base, 0755); err != nil {
		t.Fatal(err)
	}
	c := native.Config{Root: filepath.Join(base, "project"), Scratch: filepath.Join(base, "scratch"), SpoolDir: filepath.Join(base, "spool"), UID: 65534, GID: 65534, ACLReviewed: true, SystemdRun: "/usr/bin/systemd-run", Systemctl: "/usr/bin/systemctl"}
	for _, p := range []string{c.Root, c.Scratch, c.SpoolDir} {
		if err = os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []string{c.Root, c.Scratch} {
		if err = os.Chown(p, 65534, 65534); err != nil {
			t.Fatal(err)
		}
	}
	runner, err := native.New(c)
	if err != nil {
		t.Fatal(err)
	}
	r := req()
	r.OperationID = "boot-live-" + uuid.NewString()
	r.Command = protocol.Command{Executable: "/usr/bin/sleep", Args: []string{"20"}, Cwd: c.Root}
	osRecord, err := runner.Launch(context.Background(), native.Spec{ID: r.OperationID, Command: r.Command.Executable, Args: r.Command.Args, Cwd: c.Root, NetworkPolicy: "none", Limits: native.Limits{TimeoutSeconds: 25, MaxOutputBytes: 8192, MemoryBytes: 64 << 20, Pids: 16, CPUPercent: 25}})
	if err != nil {
		t.Fatal(err)
	}
	defer runner.Cancel(context.Background(), osRecord)
	j, _ := journal(t)
	rec, _, err := j.Accept(r, "machine:100", "epoch")
	if err != nil {
		t.Fatal(err)
	}
	rec, err = j.Update(rec, "running", "existing restricted native process", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(osRecord)
	if _, err = j.DB().Exec(`INSERT INTO native_runtime(operation,record)VALUES(?,?)`, r.OperationID, raw); err != nil {
		t.Fatal(err)
	}
	w := Workspace{ID: r.WorkspaceID, Root: c.Root, NativeEnabled: true, Native: &c}
	s := Service{Journal: j, Config: Config{Workspaces: []Workspace{w}}}
	for _, current := range []string{"machine:200", "osboot-v1:linux:22222222-2222-2222-2222-222222222222", ""} {
		s.BootID = current
		if err = s.tickNative(context.Background(), rec, w); err != nil {
			t.Fatal(err)
		}
		got, err := j.Get(r.OperationID)
		if err != nil || protocol.Terminal(got.Receipt.State) {
			t.Fatal("clock-derived boot change released live writer", err)
		}
		status, err := runner.Inspect(context.Background(), osRecord)
		if err != nil || !status.Running || !status.IdentityVerified {
			t.Fatal("original restricted process was not still running", err)
		}
		if s.WithWorkspaceWrite(r.WorkspaceID, func() error { t.Fatal("live writer reservation bypassed"); return nil }) == nil {
			t.Fatal("live writer lock disappeared")
		}
	}
	if err = runner.Cancel(context.Background(), osRecord); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, e := runner.Inspect(context.Background(), osRecord)
		if e == nil && !status.Running && status.IdentityVerified {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err = s.tickNative(context.Background(), rec, w); err != nil {
		t.Fatal(err)
	}
	got, err := j.Get(r.OperationID)
	if err != nil || !protocol.Terminal(got.Receipt.State) {
		t.Fatal("actual proven stop failed to release", err)
	}
}
