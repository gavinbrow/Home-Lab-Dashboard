package hostops

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"homelab/agent/internal/files"
	_ "modernc.org/sqlite"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func testManager(t *testing.T) (*Manager, *files.Root) {
	t.Helper()
	root := t.TempDir()
	r, e := files.Open(root)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { r.Close() })
	db, e := sql.Open("sqlite", filepath.Join(t.TempDir(), "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	m, e := New(db, Config{MachineID: "machine", DispatchEpoch: "epoch", DataDir: t.TempDir(), Workspaces: []WorkspaceBinding{{WorkspaceID: "ws", ApprovedRootID: "root", CanonicalRoot: root, RuntimePath: root, Type: "native", Writable: true, Revision: 1, QuotaBytes: 32}}}, map[string]*files.Root{"ws": r}, func(_ string, f func() error) error { return f() })
	if e != nil {
		t.Fatal(e)
	}
	return m, r
}
func TestMutationReceiptNoReplayAndConflictHash(t *testing.T) {
	m, _ := testManager(t)
	calls := 0
	fn := func() (any, error) { calls++; return map[string]any{"ok": true}, nil }
	a := m.mutate("op", "/v1/workspaces/ws/files", []byte("one"), fn)
	b := m.mutate("op", "/v1/workspaces/ws/files", []byte("one"), fn)
	if a.State != "completed" || b.State != "completed" || calls != 1 {
		t.Fatal(a, b, calls)
	}
	c := m.mutate("op", "/v1/workspaces/ws/files", []byte("other"), fn)
	if c.State != "conflict" || calls != 1 {
		t.Fatal(c, calls)
	}
}
func TestUnknownReservesWorkspaceAndReceiptScope(t *testing.T) {
	m, _ := testManager(t)
	r := m.mutate("unknown", "/v1/workspaces/ws/files", nil, func() (any, error) { return nil, errors.New("network lost after side effect") })
	if r.State != "outcome_unknown" || m.WorkspaceBusy("ws") == nil {
		t.Fatal("unknown released reservation", r)
	}
	called := false
	r = m.mutate("later", "/v1/workspaces/ws/files", nil, func() (any, error) { called = true; return nil, nil })
	if called || r.State != "failed" {
		t.Fatal("new mutation ran over unknown", r)
	}
	mux := http.NewServeMux()
	m.Register(mux)
	req := httptest.NewRequest("GET", "/v1/workspaces/absent/file-operations/unknown", nil)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, req)
	if out.Code != 404 {
		t.Fatal("cross workspace receipt leaked", out.Code)
	}
}
func TestMonotonicFenceSurvivesNewOperation(t *testing.T) {
	m, _ := testManager(t)
	if e := m.checkFence("job", 2); e != nil {
		t.Fatal(e)
	}
	if e := m.checkFence("job", 1); e == nil {
		t.Fatal("stale fence accepted")
	}
	if e := m.checkFence("job", 2); e != nil {
		t.Fatal(e)
	}
}
func TestPUTDurableReceiptAndQuota(t *testing.T) {
	m, _ := testManager(t)
	mux := http.NewServeMux()
	m.Register(mux)
	send := func(op, p, data string) Receipt {
		q := map[string]any{"operation_id": op, "path": p, "content_base64": data, "expected_sha256": nil}
		b, _ := json.Marshal(q)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("PUT", "/v1/workspaces/ws/files", strings.NewReader(string(b))))
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var out Receipt
		if e := json.Unmarshal(rec.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	if a := send("put1", "a", "aGk="); a.State != "completed" {
		t.Fatal(a)
	}
	if a := send("put1", "a", "aGk="); a.State != "completed" {
		t.Fatal(a)
	}
	if a := send("put2", "a", "aGk="); a.State != "conflict" || a.EffectsStarted == nil || *a.EffectsStarted {
		t.Fatal("preflight conflict not definite", a)
	}
}
func TestHelpersRejectInjectedNamesWithoutSpawn(t *testing.T) {
	for _, name := range []string{"x;touch /tmp/pwn", "--help", "x\nstop", "../service"} {
		if _, e := RunService(context.Background(), "/not/a/helper", "linux", name, "restart", 1024); e == nil {
			t.Fatal("accepted", name)
		}
	}
}
