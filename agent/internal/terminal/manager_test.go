package terminal

import (
	"context"
	"errors"
	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeConsole struct {
	reader     *io.PipeReader
	writer     *io.PipeWriter
	closed     chan struct{}
	once       sync.Once
	block      atomic.Bool
	cols, rows uint16
}

func newConsole() *fakeConsole {
	r, w := io.Pipe()
	return &fakeConsole{reader: r, writer: w, closed: make(chan struct{})}
}
func (f *fakeConsole) Read(b []byte) (int, error) { return f.reader.Read(b) }
func (f *fakeConsole) Write(b []byte) (int, error) {
	if f.block.Load() {
		<-f.closed
		return 0, io.ErrClosedPipe
	}
	return len(b), nil
}
func (f *fakeConsole) Close() error {
	f.once.Do(func() { close(f.closed); f.reader.Close(); f.writer.Close() })
	return nil
}
func (f *fakeConsole) Resize(c, r uint16) error { f.cols = c; f.rows = r; return nil }

type fakeBackend struct {
	launchError                    bool
	mu                             sync.Mutex
	console                        *fakeConsole
	launches                       int
	running, uncertain, unverified bool
	denyUnsupported                bool
	lastNetwork                    string
}

func (b *fakeBackend) Validate(s native.Spec) error {
	b.lastNetwork = s.NetworkPolicy
	if b.denyUnsupported && s.NetworkPolicy == "none" {
		return errors.New("restrictive network unavailable")
	}
	return nil
}

func (b *fakeBackend) LaunchTerminal(_ context.Context, s native.Spec, _, _ uint16) (native.Record, native.Terminal, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.launches++
	if b.launchError {
		return native.Record{}, nil, errors.New("launch acknowledgment lost")
	}
	b.running = true
	b.console = newConsole()
	return native.Record{ID: s.ID, ContainerID: "test-" + s.ID, InvocationID: "original-invocation", Identity: "restricted", Deadline: time.Now().Add(time.Duration(s.Limits.TimeoutSeconds) * time.Second)}, b.console, nil
}
func (b *fakeBackend) Inspect(context.Context, native.Record) (native.Status, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.uncertain {
		return native.Status{}, errors.New("host unavailable")
	}
	return native.Status{Exists: true, Running: b.running, IdentityVerified: true, ExitCode: 0}, nil
}
func (b *fakeBackend) Cancel(context.Context, native.Record) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.uncertain {
		return errors.New("host unavailable")
	}
	b.running = false
	b.console.writer.Close()
	return nil
}
func (b *fakeBackend) ValidProof() (native.Proof, error) {
	return native.Proof{Verified: !b.unverified}, nil
}
func fixture(t *testing.T) (Config, *fakeBackend, *atomic.Int32, *atomic.Int32) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "project")
	scratch := filepath.Join(base, "scratch")
	spool := filepath.Join(base, "spool")
	for _, p := range []string{root, scratch, spool} {
		if e := os.Mkdir(p, 0700); e != nil {
			t.Fatal(e)
		}
	}
	shell := filepath.Join(base, "trusted-shell.exe")
	if e := os.WriteFile(shell, []byte("test shell"), 0700); e != nil {
		t.Fatal(e)
	}
	acquired, released := &atomic.Int32{}, &atomic.Int32{}
	c := Config{Native: native.Config{Root: root, Scratch: scratch, SpoolDir: spool}, Shell: shell, NetworkPolicy: "none", Limits: native.Limits{TimeoutSeconds: 30, MaxOutputBytes: 8192, MemoryBytes: 64 << 20, Pids: 8, CPUPercent: 25}, DataDir: filepath.Join(spool, "terminals"), GraceSeconds: 10, IdleSeconds: 30, ReplayBytes: 1024, Acquire: func(Spec) error { acquired.Add(1); return nil }, Release: func(Record) error { released.Add(1); return nil }}
	return c, &fakeBackend{}, acquired, released
}
func request(t *testing.T, id string) Spec {
	t.Helper()
	r := protocol.Request{SchemaVersion: 1, OperationID: id, JobID: "job", StepID: "step", MachineID: "machine", ExecutionIdentityID: "identity", WorkspaceID: "workspace", WorkspaceRevision: 1, PolicyRevision: 1, Fence: 1, DispatchEpoch: "epoch", Grant: protocol.Grant{ID: "grant", Revision: 1, Tools: []string{"terminal"}}, Command: protocol.Command{Executable: "trusted-shell-marker"}, Limits: protocol.Limits{MaxToolSteps: 1, WallTimeSeconds: 30, PerCommandTimeoutSeconds: 30, MaxOutputBytes: 8192}}
	var e error
	r.RequestHash, e = protocol.Hash(r)
	if e != nil {
		t.Fatal(e)
	}
	return Spec{Request: r, Cols: 80, Rows: 24}
}
func TestDetachReattachKeepsWriterAndOutputBounded(t *testing.T) {
	c, b, acquired, released := fixture(t)
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	spec := request(t, "session-one")
	rec, e := m.Start(context.Background(), spec)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Start(context.Background(), spec); e != nil {
		t.Fatal(e)
	}
	if b.launches != 1 || acquired.Load() != 1 {
		t.Fatal("duplicate launch or writer acquire")
	}
	if _, e = b.console.writer.Write([]byte(strings.Repeat("x", 2048))); e != nil {
		t.Fatal(e)
	}
	deadline := time.Now().Add(time.Second)
	for m.record(rec.ID).OutputOffset < 2048 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	out, e := m.Read(context.Background(), rec.ID, 0, 4096)
	if e != nil || !out.Truncated || len(out.Data) != 1024 || out.Offset != 1024 {
		t.Fatalf("bounded replay: %+v %v", out, e)
	}
	if e = m.Detach(rec.ID); e != nil {
		t.Fatal(e)
	}
	if released.Load() != 0 {
		t.Fatal("detach released process writer")
	}
	out, e = m.Attach(context.Background(), rec.ID, out.NextOffset, 4096)
	if e != nil || out.Record.Native.InvocationID != rec.Native.InvocationID || out.Record.State != "running" {
		t.Fatal("did not reattach original console", e)
	}
	if e = m.Resize(rec.ID, 100, 35); e != nil {
		t.Fatal(e)
	}
	if b.console.cols != 100 || b.console.rows != 35 {
		t.Fatal("resize not delivered")
	}
	if _, e = m.Cancel(context.Background(), rec.ID); e != nil {
		t.Fatal(e)
	}
	if released.Load() != 1 {
		t.Fatal("confirmed exit did not release writer")
	}
	if _, e = os.Stat(filepath.Join(c.DataDir, rec.ID+".transcript")); !os.IsNotExist(e) {
		t.Fatal("raw recording enabled by default")
	}
}
func TestUnknownAndSupervisorRestartRetainWriter(t *testing.T) {
	c, b, _, released := fixture(t)
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	rec, e := m.Start(context.Background(), request(t, "session-recovery"))
	if e != nil {
		t.Fatal(e)
	}
	m.Close()
	m2, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m2.Close()
	if _, e = m2.Inspect(context.Background(), rec.ID); e != ErrUnknown {
		t.Fatal("reattached without original PTY endpoint", e)
	}
	if released.Load() != 0 {
		t.Fatal("restart released live writer")
	}
	if _, e = m2.Start(context.Background(), request(t, "second-writer")); e == nil {
		t.Fatal("admitted writer over unresolved console")
	}
	if _, e = m2.Cancel(context.Background(), rec.ID); e != nil {
		t.Fatal(e)
	}
	if released.Load() != 1 {
		t.Fatal("confirmed recovery cancellation did not release")
	}
}
func TestUnavailableHostNeverConfirmsCancel(t *testing.T) {
	c, b, _, released := fixture(t)
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	rec, e := m.Start(context.Background(), request(t, "session-offline"))
	if e != nil {
		t.Fatal(e)
	}
	b.mu.Lock()
	b.uncertain = true
	b.mu.Unlock()
	if _, e = m.Cancel(context.Background(), rec.ID); e == nil {
		t.Fatal("unavailable host reported cancellation")
	}
	if released.Load() != 0 {
		t.Fatal("unknown cancellation released writer")
	}
}
func TestInputBackpressureAndProofGate(t *testing.T) {
	c, b, acquired, _ := fixture(t)
	b.unverified = true
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	if _, e = m.Start(context.Background(), request(t, "unverified")); e == nil || acquired.Load() != 0 {
		t.Fatal("unverified identity admitted")
	}
	b.unverified = false
	rec, e := m.Start(context.Background(), request(t, "input-session"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Attach(context.Background(), rec.ID, 0, 1024); e != nil {
		t.Fatal(e)
	}
	b.console.block.Store(true)
	backpressure := false
	for i := 0; i < 20; i++ {
		if e = m.Input(rec.ID, []byte("input")); e == ErrBackpressure {
			backpressure = true
			break
		}
	}
	if !backpressure {
		t.Fatal("input queue not bounded")
	}
	if e = m.Input(rec.ID, make([]byte, 65537)); e == nil {
		t.Fatal("oversized input accepted")
	}
}
func TestDetachedGraceCancelsBeforeWriterRelease(t *testing.T) {
	c, b, _, released := fixture(t)
	c.GraceSeconds = 1
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	rec, e := m.Start(context.Background(), request(t, "grace-session"))
	if e != nil {
		t.Fatal(e)
	}
	if e = m.Detach(rec.ID); e != nil {
		t.Fatal(e)
	}
	if released.Load() != 0 {
		t.Fatal("detach released immediately")
	}
	deadline := time.Now().Add(4 * time.Second)
	for released.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if released.Load() != 1 {
		t.Fatal("grace expiration never verified cleanup")
	}
	b.mu.Lock()
	running := b.running
	b.mu.Unlock()
	if running {
		t.Fatal("writer released before process cancellation")
	}
}
func TestRequestedDenyCannotFallBackToRuntimeDefault(t *testing.T) {
	c, b, acquired, _ := fixture(t)
	c.NetworkPolicy = "unrestricted"
	b.denyUnsupported = true
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	s := request(t, "network-deny")
	s.Request.NetworkPolicy = &protocol.NetworkPolicy{Mode: "deny", AllowedHosts: []string{}}
	s.Request.RequestHash, _ = protocol.Hash(s.Request)
	if _, e = m.Start(context.Background(), s); e == nil {
		t.Fatal("discarded requested network deny")
	}
	if acquired.Load() != 0 || b.launches != 0 || b.lastNetwork != "none" {
		t.Fatal("unenforced policy reached launch/writer", acquired.Load(), b.launches, b.lastNetwork)
	}
	s.Request.NetworkPolicy = &protocol.NetworkPolicy{Mode: "allowlist", AllowedHosts: []string{"example.invalid"}}
	s.Request.RequestHash, _ = protocol.Hash(s.Request)
	if _, e = m.Start(context.Background(), s); e == nil {
		t.Fatal("accepted unenforced allowlist")
	}
}
func TestAmbiguousLaunchNeverReplaysOrReleasesWriter(t *testing.T) {
	c, b, acquired, released := fixture(t)
	b.launchError = true
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	s := request(t, "unknown-launch")
	rec, e := m.Start(context.Background(), s)
	if e == nil || rec.State != "outcome_unknown" {
		t.Fatal("launch ambiguity not retained", rec, e)
	}
	if _, e = m.Start(context.Background(), s); e != nil {
		t.Fatal(e)
	}
	if b.launches != 1 || acquired.Load() != 1 || released.Load() != 0 {
		t.Fatal("ambiguous launch replayed/released writer")
	}
	if _, e = m.Start(context.Background(), request(t, "replacement")); e == nil {
		t.Fatal("second writer admitted over unknown launch")
	}
}
func TestClosedManagerCannotLaunchNewTerminal(t *testing.T) {
	c, b, acquired, _ := fixture(t)
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	m.Close()
	if _, e = m.Start(context.Background(), request(t, "closed-launch")); e == nil || b.launches != 0 || acquired.Load() != 0 {
		t.Fatal("closed supervisor launched an unsupervised terminal")
	}
}
