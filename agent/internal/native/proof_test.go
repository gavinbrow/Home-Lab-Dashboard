package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProofRejectsMissingStaleAndChangedConfiguration(t *testing.T) {
	c := testConfig(t)
	r := &Runner{config: c}
	if _, e := r.ValidProof(); e == nil {
		t.Fatal("unverified configuration became verified")
	}
	digest, e := r.proofDigest()
	if e != nil {
		t.Fatal(e)
	}
	p := Proof{ObservedAt: time.Now().UTC(), ConfigDigest: digest, Identity: r.expectedProbeIdentity(), Verified: true}
	save := func() {
		b, e := json.Marshal(p)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(filepath.Join(c.SpoolDir, "identity-proof.json"), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	save()
	if _, e = r.ValidProof(); e != nil {
		t.Fatal(e)
	}
	p.ObservedAt = time.Now().Add(-6 * time.Minute)
	save()
	if _, e = r.ValidProof(); e == nil {
		t.Fatal("accepted expired proof")
	}
	p.ObservedAt = time.Now()
	save()
	r.config.Root = filepath.Join(c.Root, "changed")
	if _, e = r.ValidProof(); e == nil {
		t.Fatal("accepted proof for changed configuration")
	}
}
func TestProbeCannotUseProjectExecutable(t *testing.T) {
	c := testConfig(t)
	r := &Runner{config: c}
	executable := filepath.Join(c.Root, "agent.exe")
	if e := os.WriteFile(executable, []byte("untrusted"), 0700); e != nil {
		t.Fatal(e)
	}
	if _, e := r.Verify(context.Background(), executable, filepath.Join(c.SpoolDir, "sentinel")); e == nil {
		t.Fatal("accepted project-controlled probe executable")
	}
}

func TestFailedRecheckInvalidatesPreviousProof(t *testing.T) {
	c := testConfig(t)
	r := &Runner{config: c}
	digest, e := r.proofDigest()
	if e != nil {
		t.Fatal(e)
	}
	p := Proof{ObservedAt: time.Now(), ConfigDigest: digest, Identity: r.expectedProbeIdentity(), Verified: true}
	b, _ := json.Marshal(p)
	if e = os.WriteFile(filepath.Join(c.SpoolDir, "identity-proof.json"), b, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = r.ValidProof(); e != nil {
		t.Fatal(e)
	}
	if _, e = r.Verify(context.Background(), "relative-untrusted-command", "relative-sentinel"); e == nil {
		t.Fatal("accepted invalid recheck")
	}
	if _, e = r.ValidProof(); e == nil {
		t.Fatal("failed recheck retained prior verification")
	}
}
