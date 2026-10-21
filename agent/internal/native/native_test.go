package native

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	base := t.TempDir()
	c := Config{Root: filepath.Join(base, "project"), Scratch: filepath.Join(base, "scratch"), SpoolDir: filepath.Join(base, "private-spool"), ACLReviewed: true}
	for _, p := range []string{c.Root, c.Scratch, c.SpoolDir} {
		if e := os.Mkdir(p, 0700); e != nil {
			t.Fatal(e)
		}
	}
	return c
}
func testSpec(c Config) Spec {
	return Spec{ID: "safe-1", Command: filepath.Join(c.Root, "command.exe"), Cwd: c.Root, Limits: Limits{TimeoutSeconds: 10, MaxOutputBytes: 1024, MemoryBytes: 64 << 20, Pids: 8, CPUPercent: 50}, NetworkPolicy: "unrestricted"}
}
func TestConfigurationFailsClosed(t *testing.T) {
	c := testConfig(t)
	c.ACLReviewed = false
	if validateConfig(c) == nil {
		t.Fatal("accepted unreviewed identity ACL")
	}
	c.ACLReviewed = true
	c.SpoolDir = c.Scratch
	if validateConfig(c) == nil {
		t.Fatal("accepted execution-writable spool")
	}
}
func TestRejectUnenforceablePolicyAndCommand(t *testing.T) {
	c := testConfig(t)
	s := testSpec(c)
	if e := validate(c, s); e != nil {
		t.Fatal(e)
	}
	for _, policy := range []string{"", "allowlist", "restricted"} {
		s.NetworkPolicy = policy
		if validate(c, s) == nil {
			t.Fatal("accepted unsupported network policy", policy)
		}
	}
	s = testSpec(c)
	s.Env = map[string]string{"SECRET": "value"}
	if validate(c, s) == nil {
		t.Fatal("accepted unreviewed environment")
	}
	s = testSpec(c)
	s.ID = "../escape"
	if validate(c, s) == nil {
		t.Fatal("accepted traversal")
	}
	s = testSpec(c)
	s.Limits.TimeoutSeconds = 0
	if validate(c, s) == nil {
		t.Fatal("accepted unbounded lifetime")
	}
}
func TestBoundedSpoolAndIdentity(t *testing.T) {
	c := testConfig(t)
	r := &Runner{config: c}
	rec := Record{ID: "safe-1", OutputPath: filepath.Join(c.SpoolDir, "safe-1.log")}
	if e := os.WriteFile(rec.OutputPath, []byte("abcdef"), 0600); e != nil {
		t.Fatal(e)
	}
	b, truncated, e := r.ReadLogs(context.Background(), rec, 3)
	if e != nil || string(b) != "abc" || !truncated {
		t.Fatalf("bounded output = %q %v %v", b, truncated, e)
	}
	rec.OutputPath = filepath.Join(c.Root, "secret")
	if _, _, e = r.ReadLogs(context.Background(), rec, 3); e == nil {
		t.Fatal("accepted forged log path")
	}
}
