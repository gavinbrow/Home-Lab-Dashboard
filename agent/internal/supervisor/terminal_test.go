package supervisor

import (
	"context"
	"homelab/agent/internal/protocol"
	"homelab/agent/internal/terminal"
	"testing"
)

func TestTerminalWriterReservationSurvivesDisconnectAndBlocksAllMutations(t *testing.T) {
	j, _ := journal(t)
	r := req()
	r.Command.Executable = TerminalMarker
	rec, _, e := j.Accept(r, "boot", "epoch")
	if e != nil {
		t.Fatal(e)
	}
	rec, e = j.Update(rec, "running", "terminal", nil)
	if e != nil {
		t.Fatal(e)
	}
	s := Service{Journal: j, Config: Config{DispatchEpoch: "epoch"}}
	called := false
	mutation := func() error { called = true; return nil }
	if s.WithWorkspaceWrite(r.WorkspaceID, mutation) == nil || s.WithWorkspaceMutation(r.WorkspaceID, mutation) == nil || s.WithJournalBackup(mutation) == nil || called {
		t.Fatal("terminal writer reservation bypassed")
	}
	if e = s.Tick(context.Background()); e != nil {
		t.Fatal("tick launched terminal marker", e)
	}
	if e = s.terminalRelease(terminal.Record{ID: r.OperationID, Request: r, State: "outcome_unknown"}); e == nil {
		t.Fatal("unknown outcome released")
	}
	code := 0
	if e = s.terminalRelease(terminal.Record{ID: r.OperationID, Request: r, State: "exited", ExitCode: &code}); e != nil {
		t.Fatal(e)
	}
	if e = s.WithWorkspaceMutation(r.WorkspaceID, mutation); e != nil || !called {
		t.Fatal("proven exit failed release", e)
	}
	done, e := j.Get(r.OperationID)
	if e != nil || !protocol.Terminal(done.Receipt.State) {
		t.Fatal("terminal receipt not durable")
	}
}
