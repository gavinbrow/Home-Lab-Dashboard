//go:build linux

package native

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLiveLinuxRestrictedPTY(t *testing.T) {
	if os.Getenv("HOMELAB_NATIVE_LIVE") != "1" {
		t.Skip("explicit disposable Linux runtime authorization required")
	}
	if os.Geteuid() != 0 {
		t.Fatal("configured supervisor authority required")
	}
	base, e := os.MkdirTemp("/srv", "homelab-pty-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(base)
	os.Chmod(base, 0755)
	c := Config{Root: filepath.Join(base, "project"), Scratch: filepath.Join(base, "scratch"), SpoolDir: filepath.Join(base, "spool"), UID: 65534, GID: 65534, ACLReviewed: true, SystemdRun: "/usr/bin/systemd-run", Systemctl: "/usr/bin/systemctl"}
	for _, p := range []string{c.Root, c.Scratch, c.SpoolDir} {
		if e = os.Mkdir(p, 0700); e != nil {
			t.Fatal(e)
		}
	}
	for _, p := range []string{c.Root, c.Scratch} {
		if e = os.Chown(p, 65534, 65534); e != nil {
			t.Fatal(e)
		}
	}
	r, e := New(c)
	if e != nil {
		t.Fatal(e)
	}
	s := Spec{ID: fmt.Sprintf("pty-live-%d", time.Now().UnixNano()), Command: "/usr/bin/dash", Args: []string{"-i"}, Cwd: c.Root, NetworkPolicy: "none", Limits: Limits{TimeoutSeconds: 20, MaxOutputBytes: 8192, MemoryBytes: 64 << 20, Pids: 16, CPUPercent: 25}}
	rec, console, e := r.LaunchTerminal(context.Background(), s, 80, 24)
	if e != nil {
		t.Fatal(e)
	}
	defer console.Close()
	defer r.control(context.Background(), "reset-failed", rec.ContainerID)
	defer r.control(context.Background(), "stop", rec.ContainerID)
	output := make(chan string, 32)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, e := console.Read(buf)
			if n > 0 {
				output <- string(buf[:n])
			}
			if e != nil {
				close(output)
				return
			}
		}
	}()
	var text strings.Builder
	wait := func(marker string) {
		t.Helper()
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		for !strings.Contains(text.String(), marker) {
			select {
			case part, ok := <-output:
				if !ok {
					t.Fatalf("pty ended before marker %q: %q", marker, text.String())
				}
				text.WriteString(part)
			case <-timer.C:
				t.Fatalf("missing pty marker %q: %q", marker, text.String())
			}
		}
	}
	if _, e = console.Write([]byte("id\nstty size\n")); e != nil {
		t.Fatal(e)
	}
	wait("uid=65534(nobody)")
	wait("24 80")
	if e = console.Resize(100, 35); e != nil {
		t.Fatal(e)
	}
	console.Write([]byte("stty size\n"))
	wait("35 100")
	console.Write([]byte("head -c 16384 /dev/zero > pty-data; wc -c pty-data\n"))
	wait("16384 pty-data")
	status, e := r.Inspect(context.Background(), rec)
	if e != nil || !status.Running || !status.IdentityVerified {
		t.Fatalf("actual restricted PTY identity: %+v %v", status, e)
	}
	console.Write([]byte("sleep 30\n"))
	time.Sleep(100 * time.Millisecond)
	console.Write([]byte{3})
	console.Write([]byte("printf 'CTRL_%s_OK\\n' C\n"))
	wait("CTRL_C_OK\r\n")
	if e = r.Cancel(context.Background(), rec); e != nil {
		t.Fatal(e)
	}
	status, e = r.Inspect(context.Background(), rec)
	if e != nil || status.Running {
		t.Fatalf("PTY descendants not stopped: %+v %v", status, e)
	}
	t.Logf("restricted PTY actual uid65534, initial/resize80x24→100x35, Ctrl+C, cgroup cancel passed; invocation=%s", rec.InvocationID)
}
