package supervisor

import (
	"context"
	"homelab/agent/internal/protocol"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func req() protocol.Request {
	return protocol.Request{SchemaVersion: 1, OperationID: "operation-1", RequestHash: "hash", JobID: "job-1", StepID: "step-1", MachineID: "machine-1", WorkspaceID: "workspace-1", WorkspaceRevision: 1, Fence: 1, DispatchEpoch: "epoch", Limits: protocol.Limits{MaxToolSteps: 60, PerCommandTimeoutSeconds: 30, WallTimeSeconds: 30, MaxOutputBytes: 100}}
}
func journal(t *testing.T) (*Journal, string) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "state", "journal.db")
	j, e := OpenJournal(p)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { j.Close() })
	return j, p
}
func TestDurableDuplicateAndConflict(t *testing.T) {
	j, p := journal(t)
	r := req()
	a, fresh, e := j.Accept(r, "boot", "epoch")
	if e != nil || !fresh {
		t.Fatal(e)
	}
	b, fresh, e := j.Accept(r, "boot", "epoch")
	if e != nil || fresh || b.Receipt.HostSequence != a.Receipt.HostSequence {
		t.Fatal("duplicate changed receipt", e)
	}
	r.RequestHash = "different"
	if _, _, e = j.Accept(r, "boot", "epoch"); e != ErrConflict {
		t.Fatal(e)
	}
	j.Close()
	j2, e := OpenJournal(p)
	if e != nil {
		t.Fatal(e)
	}
	defer j2.Close()
	b, e = j2.Get(r.OperationID)
	if e != nil || b.Receipt.RequestHash != "hash" {
		t.Fatal("journal not durable", e)
	}
}
func TestConcurrentFencesNeverDecrease(t *testing.T) {
	j, _ := journal(t)
	r, _, e := j.Accept(req(), "boot", "epoch")
	if e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := int64(2); i <= 100; i++ {
		wg.Add(1)
		go func(f int64) {
			defer wg.Done()
			e := j.CheckFence(r, f, "epoch")
			if e != nil && e != ErrFence {
				t.Error(e)
			}
		}(i)
	}
	wg.Wait()
	if e = j.CheckFence(r, 99, "epoch"); e != ErrFence {
		t.Fatal("stale fence accepted", e)
	}
	if e = j.CheckFence(r, 100, "other"); e != ErrFence {
		t.Fatal("wrong epoch accepted", e)
	}
}

type fakeBackend struct {
	creates, starts, stops int
	status                 ContainerStatus
	logs                   []byte
}

func (b *fakeBackend) Create(context.Context, Record, Workspace) error          { b.creates++; return nil }
func (b *fakeBackend) Start(context.Context, string) error                      { b.starts++; return nil }
func (b *fakeBackend) Inspect(context.Context, string) (ContainerStatus, error) { return b.status, nil }
func (b *fakeBackend) Stop(context.Context, string) error {
	b.stops++
	b.status.Running = false
	return nil
}
func (b *fakeBackend) Logs(context.Context, string, int64) ([]byte, bool, error) {
	return b.logs, false, nil
}
func TestAmbiguousLaunchNeverReplayed(t *testing.T) {
	j, _ := journal(t)
	r, _, _ := j.Accept(req(), "boot", "epoch")
	r, e := j.Update(r, "launching", "injected_crash_after_launch_intent", nil)
	if e != nil {
		t.Fatal(e)
	}
	backend := &fakeBackend{}
	s := Service{Journal: j, Backend: backend, BootID: "boot"}
	if e = s.Tick(context.Background()); e != nil {
		t.Fatal(e)
	}
	rec, _ := j.Get(r.Request.OperationID)
	if rec.Receipt.State != "outcome_unknown" || backend.starts != 0 || backend.creates != 0 {
		t.Fatal("ambiguous launch replayed", rec.Receipt)
	}
	if e = s.Tick(context.Background()); e != nil {
		t.Fatal(e)
	}
	if backend.starts != 0 {
		t.Fatal("replayed unknown operation")
	}
}
func TestCancelProvesContainmentStopped(t *testing.T) {
	j, _ := journal(t)
	r, _, _ := j.Accept(req(), "boot", "epoch")
	r, _ = j.Update(r, "running", "", nil)
	backend := &fakeBackend{status: ContainerStatus{Exists: true, Running: true, OperationID: r.Request.OperationID}}
	s := Service{Config: Config{DispatchEpoch: "epoch"}, Journal: j, Backend: backend, BootID: "boot"}
	receipt, e := s.Cancel(r.Request.OperationID, 2, "epoch")
	if e != nil || receipt.State != "cancelling" {
		t.Fatal(receipt, e)
	}
	if e = s.Tick(context.Background()); e != nil {
		t.Fatal(e)
	}
	rec, _ := j.Get(r.Request.OperationID)
	if rec.Receipt.State != "cancelled" || backend.stops != 1 {
		t.Fatal(rec.Receipt, backend.stops)
	}
}
func TestCreatedContainerNeverReportedAsSuccess(t *testing.T) {
	j, _ := journal(t)
	r, _, _ := j.Accept(req(), "boot", "epoch")
	r, _ = j.Update(r, "launching", "", nil)
	backend := &fakeBackend{status: ContainerStatus{Exists: true, Created: true, OperationID: r.Request.OperationID}}
	s := Service{Journal: j, Backend: backend, BootID: "boot"}
	if e := s.Tick(context.Background()); e != nil {
		t.Fatal(e)
	}
	rec, _ := j.Get(r.Request.OperationID)
	if rec.Receipt.State != "interrupted" || backend.starts != 0 {
		t.Fatal(rec.Receipt)
	}
}
func TestExpiredReceiptCannotLaunch(t *testing.T) {
	j, _ := journal(t)
	r, _, _ := j.Accept(req(), "boot", "epoch")
	j.db.Exec(`UPDATE operations SET deadline=? WHERE id=?`, time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano), r.Request.OperationID)
	backend := &fakeBackend{}
	s := Service{Journal: j, Backend: backend}
	if e := s.Tick(context.Background()); e != nil {
		t.Fatal(e)
	}
	rec, _ := j.Get(r.Request.OperationID)
	if rec.Receipt.State != "interrupted" || backend.creates != 0 {
		t.Fatal(rec.Receipt)
	}
}
func TestUnconfiguredIdentityFailsClosed(t *testing.T) {
	r := req()
	r.Command = protocol.Command{Executable: "/bin/echo", Cwd: "/workspace/project", Args: []string{}, Env: map[string]string{}}
	r.PolicyRevision = 1
	r.Grant = protocol.Grant{Revision: 1}
	r.RequestHash, _ = protocol.Hash(r)
	s := Service{Config: Config{MachineID: r.MachineID, DispatchEpoch: "epoch", Workspaces: []Workspace{{ID: r.WorkspaceID}}}}
	e := s.Authorize(r)
	if e == nil || e.Error() != "native_execution_disabled_identity_and_containment_unverified" {
		t.Fatal(e)
	}
}
func TestLogReplayDoesNotDuplicate(t *testing.T) {
	j, _ := journal(t)
	r, _, _ := j.Accept(req(), "boot", "epoch")
	r, _ = j.Update(r, "running", "", nil)
	backend := &fakeBackend{status: ContainerStatus{Exists: true, Running: true, OperationID: r.Request.OperationID}, logs: []byte("one\ntwo\n")}
	s := Service{Journal: j, Backend: backend, BootID: "boot"}
	if e := s.Tick(context.Background()); e != nil {
		t.Fatal(e)
	}
	if e := s.Tick(context.Background()); e != nil {
		t.Fatal(e)
	}
	logs, e := j.Logs(r.Request.OperationID, 0)
	if e != nil || len(logs) != 1 || logs[0].Data != "one\ntwo\n" {
		t.Fatal(logs, e)
	}
}
