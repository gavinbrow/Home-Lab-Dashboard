//go:build linux

package native

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// This is deliberately opt-in: it uses an already provisioned nobody account and
// creates only disposable directories and uniquely named transient systemd units.
func TestLiveLinuxRestrictedIdentityAndCgroup(t *testing.T) {
	if os.Getenv("HOMELAB_NATIVE_LIVE") != "1" {
		t.Skip("requires explicit disposable systemd runtime authorization")
	}
	if os.Geteuid() != 0 {
		t.Fatal("transient-unit supervisor must have configured service manager authority")
	}
	base, e := os.MkdirTemp("/srv", "homelab-native-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(base)
	if e = os.Chmod(base, 0755); e != nil {
		t.Fatal(e)
	}
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
	run := func(name, script string, timeout int, cancel bool) {
		t.Helper()
		scriptPath := filepath.Join(c.Root, "fixture-"+name+".sh")
		if e := os.WriteFile(scriptPath, []byte(script), 0644); e != nil {
			t.Fatal(e)
		}
		s := Spec{ID: fmt.Sprintf("native-live-%s-%d", name, time.Now().UnixNano()), Command: "/bin/sh", Args: []string{scriptPath}, Cwd: c.Root, Limits: Limits{TimeoutSeconds: timeout, MaxOutputBytes: 8192, MemoryBytes: 64 << 20, Pids: 16, CPUPercent: 25}, NetworkPolicy: "none"}
		launchContext, cancelLaunch := context.WithCancel(context.Background())
		rec, e := r.Launch(launchContext, s)
		cancelLaunch() // connection/request context ending must not stop the OS unit
		if e != nil {
			t.Fatal(e)
		}
		defer r.control(context.Background(), "stop", rec.ContainerID)
		defer r.control(context.Background(), "reset-failed", rec.ContainerID)
		if cancel {
			time.Sleep(250 * time.Millisecond)
			reattached, e := New(c)
			if e != nil {
				t.Fatal(e)
			}
			status, e := reattached.Inspect(context.Background(), rec)
			if e != nil || !status.Running || !status.IdentityVerified {
				t.Fatalf("running credentials: %+v %v", status, e)
			}
			if e = reattached.Cancel(context.Background(), rec); e != nil {
				t.Fatal(e)
			}
		}
		deadline := time.Now().Add(10 * time.Second)
		var status Status
		for time.Now().Before(deadline) {
			status, e = r.Inspect(context.Background(), rec)
			if e != nil {
				t.Fatal(e)
			}
			if !status.Running {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if status.Running || !status.IdentityVerified {
			t.Fatalf("containment did not finish: %+v", status)
		}
		b, truncated, e := r.ReadLogs(context.Background(), rec, 8192)
		if e != nil {
			t.Fatal(e)
		}
		t.Logf("operation=%s invocation=%s identity=%s result=%s exit=%d bytes=%d output=%q", rec.ID, rec.InvocationID, rec.Identity, status.Reason, status.ExitCode, len(b), strings.TrimSpace(string(b[:min(len(b), 100)])))
		if !strings.Contains(string(b), "uid=65534") {
			t.Fatal("actual identity proof missing")
		}
		if name == "identity" && status.ExitCode != 0 {
			t.Fatalf("identity/scope command failed: %+v", status)
		}
		if name == "deadline" && status.Reason != "timeout" {
			t.Fatalf("kernel runtime deadline was not proven: %+v", status)
		}
		if name == "output" && (!truncated || len(b) > 8192) {
			t.Fatal("output quota not enforced")
		}
		if name == "identity" {
			hostNamespace, e := os.Readlink("/proc/self/ns/net")
			if e != nil {
				t.Fatal(e)
			}
			if strings.Contains(string(b), hostNamespace) {
				t.Fatal("private network namespace was not enforced")
			}
		}
		if name == "cancel" || name == "deadline" {
			pidBytes, e := os.ReadFile(filepath.Join(c.Root, "child-"+name))
			if e != nil {
				t.Fatal(e)
			}
			pid, e := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
			if e != nil {
				t.Fatal(e)
			}
			if e = syscall.Kill(pid, 0); e == nil {
				data, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
				if e == nil && !strings.Contains(string(data), ") Z ") {
					t.Fatal("descendant still running", pid)
				}
			}
		}
	}
	run("identity", "id; readlink /proc/self/ns/net; printf allowed > '"+c.Root+"/allowed'; if printf denied > '"+base+"/forbidden'; then exit 23; fi", 5, false)
	if _, e = os.Stat(filepath.Join(c.Root, "allowed")); e != nil {
		t.Fatal("approved project write missing", e)
	}
	if _, e = os.Stat(filepath.Join(base, "forbidden")); !os.IsNotExist(e) {
		t.Fatal("outside-project write was not denied")
	}
	run("cancel", "id; sleep 30 & child=$!; echo \"$child\" > '"+c.Root+"/child-cancel'; wait", 30, true)
	run("deadline", "id; sleep 30 & child=$!; echo \"$child\" > '"+c.Root+"/child-deadline'; wait", 2, false)
	run("output", "id; head -c 16384 /dev/zero", 5, false)
}

func TestLiveLinuxIdentityProof(t *testing.T) {
	if os.Getenv("HOMELAB_NATIVE_LIVE") != "1" {
		t.Skip("requires explicit disposable systemd runtime authorization")
	}
	executable := os.Getenv("HOMELAB_NATIVE_AGENT_EXE")
	if executable == "" {
		t.Skip("requires trusted compiled agent identity-probe executable")
	}
	if os.Geteuid() != 0 {
		t.Fatal("configured transient-unit supervisor authority required")
	}
	base, e := os.MkdirTemp("/srv", "homelab-native-proof-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(base)
	if e = os.Chmod(base, 0755); e != nil {
		t.Fatal(e)
	}
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
	defer func() {
		entries, _ := os.ReadDir(c.SpoolDir)
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "identity-probe-") && strings.HasSuffix(entry.Name(), ".log") {
				id := strings.TrimSuffix(entry.Name(), ".log")
				if validID.MatchString(id) {
					r.control(context.Background(), "stop", "homelab-"+id+".service")
					r.control(context.Background(), "reset-failed", "homelab-"+id+".service")
				}
			}
		}
	}()
	sentinel := filepath.Join(c.SpoolDir, "identity-denied-sentinel")
	if e = os.WriteFile(sentinel, []byte("nonsecret-disposable-access-probe"), 0600); e != nil {
		t.Fatal(e)
	}
	if os.Getenv("HOMELAB_NATIVE_COPY_PROBE") == "1" {
		source, e := os.ReadFile(executable)
		if e != nil {
			t.Fatal(e)
		}
		executable = filepath.Join(base, "trusted-agent")
		if e = os.WriteFile(executable, source, 0755); e != nil {
			t.Fatal(e)
		}
	}
	proof, e := r.Verify(context.Background(), executable, sentinel)
	if e != nil {
		entries, _ := os.ReadDir(c.SpoolDir)
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "identity-probe-") && strings.HasSuffix(entry.Name(), ".log") {
				data, _ := os.ReadFile(filepath.Join(c.SpoolDir, entry.Name()))
				t.Logf("disposable trusted probe stdout/stderr %s: %q", entry.Name(), data)
				status, _ := r.control(context.Background(), "show", "homelab-"+strings.TrimSuffix(entry.Name(), ".log")+".service", "--property=Result,ExecMainStatus,ExecMainCode,MemoryCurrent,TasksCurrent")
				t.Log(status)
			}
		}
		t.Fatal(e)
	}
	if !proof.Verified || proof.Identity != "65534" {
		t.Fatalf("actual identity proof invalid: %+v", proof)
	}
	if _, e = r.ValidProof(); e != nil {
		t.Fatal(e)
	}
	t.Logf("trusted helper actual proof identity=%s observed=%s config_digest=%s", proof.Identity, proof.ObservedAt.Format(time.RFC3339), proof.ConfigDigest)
	r.config.UID = 65533
	if _, e = r.ValidProof(); e == nil {
		t.Fatal("configuration change did not invalidate real proof")
	}
	r.config.UID = 65534
	if _, e = r.Verify(context.Background(), executable, filepath.Join(c.Root, "invalid-denied-path")); e == nil {
		t.Fatal("accepted unprotected denied path")
	}
	if _, e = r.ValidProof(); e == nil {
		t.Fatal("failed recheck retained green identity")
	}
}
