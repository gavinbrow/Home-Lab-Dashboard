package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"homelab/agent/internal/protocol"
	"homelab/agent/internal/supervisor"
	"os"
	"path/filepath"
	"testing"
)

func TestStateLockRejectsConcurrentSupervisor(t *testing.T) {
	dir := t.TempDir()
	release, e := lockState(dir)
	if e != nil {
		t.Fatal(e)
	}
	if second, e := lockState(dir); e == nil {
		second()
		release()
		t.Fatal("concurrent supervisor accepted")
	}
	release()
	third, e := lockState(dir)
	if e != nil {
		t.Fatal(e)
	}
	third()
}
func TestTrustReconcilePreservesUnknownOperations(t *testing.T) {
	dir := t.TempDir()
	pub, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	pubPath := filepath.Join(dir, "dispatch.pem")
	os.WriteFile(pubPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600)
	cfg := supervisor.Config{MachineID: "machine", DispatchEpoch: "old", DataDir: filepath.Join(dir, "state"), DispatchKeyID: "old", DispatchPublicKeyFile: pubPath}
	configPath := filepath.Join(dir, "config.json")
	if e = persistConfigFile(configPath, cfg); e != nil {
		t.Fatal(e)
	}
	journal, e := supervisor.OpenJournal(filepath.Join(cfg.DataDir, "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	request := protocol.Request{OperationID: "operation", JobID: "job", RequestHash: "original", Fence: 1, DispatchEpoch: "old", Limits: protocol.Limits{MaxToolSteps: 1, WallTimeSeconds: 60, PerCommandTimeoutSeconds: 30}}
	record, _, e := journal.Accept(request, "boot", "old")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = journal.Update(record, "outcome_unknown", "injected_unknown", nil); e != nil {
		t.Fatal(e)
	}
	journal.Close()
	epoch := "77777777-7777-4777-8777-777777777777"
	args := []string{"--config", configPath, "--dispatch-epoch", epoch, "--dispatch-public-key-file", pubPath, "--key-id", "restored"}
	if e = trustReconcile(args); e == nil {
		t.Fatal("unknown operation silently acknowledged")
	}
	args = append(args, "--allow-unresolved")
	if e = trustReconcile(args); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(configPath)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(raw, &cfg); e != nil || cfg.DispatchEpoch != epoch {
		t.Fatal(cfg, e)
	}
	journal, e = supervisor.OpenJournal(filepath.Join(cfg.DataDir, "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer journal.Close()
	record, e = journal.Get("operation")
	if e != nil || record.Receipt.State != "outcome_unknown" || record.Receipt.RequestHash != "original" {
		t.Fatal(record, e)
	}
	if e = journal.CheckFence(record, 2, epoch); e != nil {
		t.Fatal("original operation cannot reconcile under new trusted epoch", e)
	}
}
