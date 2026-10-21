// Package terminal owns restricted workspace console processes independently
// from HTTP/WebSocket clients. The host must authorize each operation and hold
// its durable workspace writer reservation until Release confirms OS exit.
package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
)

var ErrBackpressure = errors.New("terminal_input_backpressure")
var ErrUnknown = errors.New("terminal_outcome_unknown_writer_retained")

type Config struct {
	Native           native.Config      `json:"native"`
	Container        *ContainerConfig   `json:"container,omitempty"`
	Shell            string             `json:"shell"`
	Args             []string           `json:"args"`
	NetworkPolicy    string             `json:"network_policy"`
	Limits           native.Limits      `json:"limits"`
	DataDir          string             `json:"data_dir"`
	GraceSeconds     int                `json:"grace_seconds"`
	IdleSeconds      int                `json:"idle_seconds"`
	ReplayBytes      int                `json:"replay_bytes"`
	RecordTranscript bool               `json:"record_transcript"`
	BootID           string             `json:"boot_id"`
	Acquire          func(Spec) error   `json:"-"`
	Release          func(Record) error `json:"-"`
}
type Spec struct {
	Request      protocol.Request `json:"request"`
	Cols         uint16           `json:"cols"`
	Rows         uint16           `json:"rows"`
	RetainOutput bool             `json:"retain_output"`
}
type Record struct {
	ID           string           `json:"id"`
	Request      protocol.Request `json:"request"`
	Native       native.Record    `json:"native"`
	State        string           `json:"state"`
	Reason       string           `json:"reason"`
	CreatedAt    time.Time        `json:"created_at"`
	UpdatedAt    time.Time        `json:"updated_at"`
	DetachedAt   time.Time        `json:"detached_at"`
	ExpiresAt    time.Time        `json:"expires_at"`
	Cols         uint16           `json:"cols"`
	Rows         uint16           `json:"rows"`
	OutputOffset int64            `json:"output_offset"`
	ExitCode     *int             `json:"exit_code,omitempty"`
	ClientID     string           `json:"client_id,omitempty"`
	RetainOutput bool             `json:"retain_output"`
	BootID       string           `json:"boot_id"`
}
type Output struct {
	Data       []byte `json:"data"`
	Offset     int64  `json:"offset"`
	NextOffset int64  `json:"next_offset"`
	Truncated  bool   `json:"truncated"`
	Record     Record `json:"record"`
}
type backend interface {
	LaunchTerminal(context.Context, native.Spec, uint16, uint16) (native.Record, native.Terminal, error)
	Inspect(context.Context, native.Record) (native.Status, error)
	Cancel(context.Context, native.Record) error
	ValidProof() (native.Proof, error)
}
type session struct {
	inspectMu       sync.Mutex
	record          Record
	console         native.Terminal
	ring            []byte
	base            int64
	input           chan []byte
	stop            chan struct{}
	stopped         bool
	released        bool
	lastActivity    time.Time
	transcript      *os.File
	transcriptBytes int64
	outputDone      chan struct{}
}
type Manager struct {
	mu        sync.Mutex
	config    Config
	backend   backend
	sessions  map[string]*session
	done      chan struct{}
	closeOnce sync.Once
	closed    bool
}

func New(c Config) (*Manager, error) {
	if c.Container != nil {
		b, e := newContainerBackend(*c.Container)
		if e != nil {
			return nil, e
		}
		c.Native.Root = c.Container.Root
		c.Native.Scratch = c.Container.Root
		c.Native.SpoolDir = c.Container.SpoolDir
		return newManager(c, b)
	}
	b, e := native.New(c.Native)
	if e != nil {
		return nil, e
	}
	return newManager(c, b)
}
func newManager(c Config, b backend) (*Manager, error) {
	if c.Acquire == nil || c.Release == nil {
		return nil, errors.New("terminal_durable_writer_callbacks_required")
	}
	if c.GraceSeconds < 1 || c.GraceSeconds > 3600 || c.IdleSeconds < 1 || c.IdleSeconds > 86400 || c.ReplayBytes < 1024 || c.ReplayBytes > 8<<20 {
		return nil, errors.New("terminal_invalid_lifetime_or_replay_limits")
	}
	l := c.Limits
	if l.TimeoutSeconds < 1 || l.TimeoutSeconds > 86400 || l.MaxOutputBytes < 1 || l.MaxOutputBytes > 1<<30 || l.MemoryBytes < 16<<20 || l.Pids < 1 || l.Pids > 4096 || l.CPUPercent < 1 || l.CPUPercent > 100 {
		return nil, errors.New("terminal_invalid_resource_limits")
	}
	if !filepath.IsAbs(c.Shell) {
		return nil, errors.New("terminal_trusted_absolute_shell_required")
	}
	if c.Container == nil {
		shell, e := filepath.EvalSymlinks(c.Shell)
		if e != nil || shell != c.Shell {
			return nil, errors.New("terminal_canonical_trusted_shell_required")
		}
		for _, root := range []string{c.Native.Root, c.Native.Scratch} {
			rel, e := filepath.Rel(root, shell)
			if e != nil || filepath.IsLocal(rel) {
				return nil, errors.New("terminal_shell_must_be_outside_writable_roots")
			}
		}
	}
	rel, e := filepath.Rel(c.Native.SpoolDir, c.DataDir)
	if e != nil || !filepath.IsLocal(rel) {
		return nil, errors.New("terminal_state_requires_protected_spool_directory")
	}
	if e = os.MkdirAll(c.DataDir, 0700); e != nil {
		return nil, e
	}
	resolved, e := filepath.EvalSymlinks(c.DataDir)
	if e != nil || resolved != c.DataDir {
		return nil, errors.New("terminal_state_directory_links_rejected")
	}
	m := &Manager{config: c, backend: b, sessions: map[string]*session{}, done: make(chan struct{})}
	entries, e := os.ReadDir(c.DataDir)
	if e != nil {
		return nil, e
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, e := os.ReadFile(filepath.Join(c.DataDir, entry.Name()))
		if e != nil {
			return nil, e
		}
		var rec Record
		if e = json.Unmarshal(data, &rec); e != nil {
			return nil, e
		}
		if !protocol.ValidID(rec.ID) || entry.Name() != rec.ID+".json" {
			return nil, errors.New("terminal_corrupt_session_identity")
		}
		if rec.State != "exited" {
			rec.State = "outcome_unknown"
			rec.Reason = "supervisor_restarted_pty_endpoint_unavailable"
		}
		rec.ClientID = ""
		s := &session{record: rec, base: rec.OutputOffset, lastActivity: time.Now(), input: make(chan []byte, 8), stop: make(chan struct{})}
		m.sessions[rec.ID] = s
		if e = m.persist(s); e != nil {
			return nil, e
		}
	}
	go m.monitor()
	return m, nil
}
func dimensions(cols, rows uint16) bool { return cols >= 2 && cols <= 500 && rows >= 2 && rows <= 300 }
func (m *Manager) persist(s *session) error {
	data, e := json.Marshal(s.record)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(m.config.DataDir, "session-*.tmp")
	if e != nil {
		return e
	}
	path := f.Name()
	defer os.Remove(path)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(data)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = os.Rename(path, filepath.Join(m.config.DataDir, s.record.ID+".json")); e != nil {
		return e
	}
	return syncDirectory(m.config.DataDir)
}
func (m *Manager) Start(ctx context.Context, spec Spec) (Record, error) {
	if e := ctx.Err(); e != nil {
		return Record{}, e
	}
	if !dimensions(spec.Cols, spec.Rows) {
		return Record{}, errors.New("terminal_invalid_dimensions")
	}
	// Preserve an immutable authorization snapshot rather than retaining caller
	// maps/slices that could later change while the console continues running.
	encoded, e := json.Marshal(spec.Request)
	if e != nil {
		return Record{}, e
	}
	if e = json.Unmarshal(encoded, &spec.Request); e != nil {
		return Record{}, e
	}
	if e := spec.Request.Validate(); e != nil {
		return Record{}, e
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Record{}, errors.New("terminal_manager_closed")
	}
	id := spec.Request.OperationID
	if old, ok := m.sessions[id]; ok {
		if old.record.Request.RequestHash != spec.Request.RequestHash || old.record.RetainOutput != spec.RetainOutput {
			return Record{}, errors.New("terminal_session_id_conflict")
		}
		return old.record, nil
	}
	for _, s := range m.sessions {
		if s.record.Request.WorkspaceID == spec.Request.WorkspaceID && s.record.State != "exited" {
			return Record{}, errors.New("workspace_busy_terminal_writer")
		}
	}
	limits := m.config.Limits
	limits.TimeoutSeconds = min(limits.TimeoutSeconds, spec.Request.Limits.PerCommandTimeoutSeconds, spec.Request.Limits.WallTimeSeconds)
	limits.MaxOutputBytes = min(limits.MaxOutputBytes, spec.Request.Limits.MaxOutputBytes)
	network := m.config.NetworkPolicy
	if policy := spec.Request.NetworkPolicy; policy != nil {
		if len(policy.AllowedHosts) != 0 || policy.Mode != "deny" && policy.Mode != "runtime_default" {
			return Record{}, errors.New("terminal_network_allowlist_unenforceable")
		}
		if policy.Mode == "deny" {
			network = "none"
		}
	}
	cmd := native.Spec{ID: id, Command: m.config.Shell, Args: m.config.Args, Cwd: m.config.Native.Root, Limits: limits, NetworkPolicy: network}
	if c := m.config.Container; c != nil {
		if spec.Request.MachineID != c.MachineID || spec.Request.WorkspaceID != c.WorkspaceID || spec.Request.EnvironmentID == nil || *spec.Request.EnvironmentID != c.EnvironmentID || spec.Request.EnvironmentGeneration == nil || *spec.Request.EnvironmentGeneration != c.Generation {
			return Record{}, errors.New("terminal_container_environment_snapshot_mismatch")
		}
		cmd.Cwd = "/workspace/project"
	}
	if validator, ok := m.backend.(interface{ Validate(native.Spec) error }); ok {
		if e := validator.Validate(cmd); e != nil {
			return Record{}, e
		}
	}
	if p, e := m.backend.ValidProof(); e != nil || !p.Verified {
		return Record{}, errors.New("terminal_verified_execution_identity_required")
	}
	if e := m.config.Acquire(spec); e != nil {
		return Record{}, e
	}
	now := time.Now().UTC()
	s := &session{record: Record{ID: id, Request: spec.Request, State: "launching", Reason: "launch_reserved", CreatedAt: now, UpdatedAt: now, Cols: spec.Cols, Rows: spec.Rows, ExpiresAt: now.Add(time.Duration(m.config.Limits.TimeoutSeconds) * time.Second)}, lastActivity: now, input: make(chan []byte, 8), stop: make(chan struct{}), outputDone: make(chan struct{})}
	s.record.RetainOutput = spec.RetainOutput
	s.record.BootID = m.config.BootID
	m.sessions[id] = s
	if e := m.persist(s); e != nil {
		s.record.State = "outcome_unknown"
		s.record.Reason = "launch_journal_unavailable_writer_retained"
		return s.record, e
	}
	// Client disconnect after admission is not a command cancellation signal.
	launchCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	rec, console, e := m.backend.LaunchTerminal(launchCtx, cmd, spec.Cols, spec.Rows)
	cancel()
	if e != nil {
		s.record.State = "outcome_unknown"
		s.record.Reason = "terminal_launch_outcome_unknown"
		m.persist(s)
		return s.record, e
	}
	s.record.Native = rec
	s.console = console
	s.record.State = "detached"
	s.record.Reason = "restricted_console_waiting_for_client"
	s.record.UpdatedAt = time.Now().UTC()
	s.record.DetachedAt = s.record.UpdatedAt
	s.record.ExpiresAt = rec.Deadline
	if e = m.persist(s); e != nil {
		s.record.State = "outcome_unknown"
		s.record.Reason = "terminal_launch_receipt_unavailable"
		go m.output(s, console)
		go m.input(s, console)
		return s.record, e
	}
	if m.config.RecordTranscript && spec.RetainOutput {
		s.transcript, e = os.OpenFile(filepath.Join(m.config.DataDir, id+".transcript"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			s.record.Reason = "transcript_unavailable"
		}
	}
	go m.output(s, console)
	go m.input(s, console)
	return s.record, nil
}
func (m *Manager) output(s *session, console native.Terminal) {
	defer close(s.outputDone)
	buffer := make([]byte, 16384)
	for {
		n, e := console.Read(buffer)
		if n > 0 {
			m.mu.Lock()
			s.ring = append(s.ring, buffer[:n]...)
			if len(s.ring) > m.config.ReplayBytes {
				drop := len(s.ring) - m.config.ReplayBytes
				s.ring = append([]byte(nil), s.ring[drop:]...)
				s.base += int64(drop)
			}
			s.record.OutputOffset += int64(n)
			if s.transcript != nil && s.transcriptBytes < m.config.Limits.MaxOutputBytes {
				keep := min(int64(n), m.config.Limits.MaxOutputBytes-s.transcriptBytes)
				written, writeErr := s.transcript.Write(buffer[:keep])
				s.transcriptBytes += int64(written)
				if writeErr != nil {
					s.record.Reason = "transcript_write_failed"
					s.transcript.Close()
					s.transcript = nil
				}
			}
			m.mu.Unlock()
		}
		if e != nil {
			return
		}
	}
}
func (m *Manager) input(s *session, console native.Terminal) {
	for {
		select {
		case <-s.stop:
			return
		case data := <-s.input:
			if _, e := console.Write(data); e != nil {
				return
			}
		}
	}
}
func (m *Manager) find(id string) (*session, error) {
	s, ok := m.sessions[id]
	if !ok {
		return nil, os.ErrNotExist
	}
	return s, nil
}
func (m *Manager) Read(ctx context.Context, id string, after int64, maxBytes int) (Output, error) {
	if e := ctx.Err(); e != nil {
		return Output{}, e
	}
	if maxBytes < 1 || maxBytes > 65536 || after < 0 {
		return Output{}, errors.New("terminal_invalid_output_cursor")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, e := m.find(id)
	if e != nil {
		return Output{}, e
	}
	if after > s.record.OutputOffset {
		return Output{}, errors.New("terminal_cursor_ahead")
	}
	truncated := after < s.base
	if truncated {
		after = s.base
	}
	start := int(after - s.base)
	end := min(start+maxBytes, len(s.ring))
	data := make([]byte, end-start)
	copy(data, s.ring[start:end])
	return Output{Data: data, Offset: after, NextOffset: after + int64(len(data)), Truncated: truncated, Record: s.record}, nil
}
func (m *Manager) Attach(ctx context.Context, id string, after int64, maxBytes int) (Output, error) {
	return m.AttachClient(ctx, id, "legacy", after, maxBytes)
}
func (m *Manager) AttachClient(ctx context.Context, id, clientID string, after int64, maxBytes int) (Output, error) {
	if e := ctx.Err(); e != nil {
		return Output{}, e
	}
	if !protocol.ValidID(clientID) {
		return Output{}, errors.New("terminal_invalid_client_id")
	}
	m.mu.Lock()
	s, e := m.find(id)
	if e != nil {
		m.mu.Unlock()
		return Output{}, e
	}
	if s.record.State == "detached" {
		s.record.State = "running"
		s.record.Reason = "reattached_original_console"
		s.record.DetachedAt = time.Time{}
		s.record.UpdatedAt = time.Now().UTC()
		e = m.persist(s)
	}
	if s.record.State == "running" {
		s.record.ClientID = clientID
		s.record.UpdatedAt = time.Now().UTC()
		e = m.persist(s)
	}
	s.lastActivity = time.Now()
	m.mu.Unlock()
	if e != nil {
		return Output{}, e
	}
	return m.Read(ctx, id, after, maxBytes)
}
func (m *Manager) Input(id string, data []byte) error {
	return m.inputClient(id, "", data)
}
func (m *Manager) InputClient(id, clientID string, data []byte) error {
	if !protocol.ValidID(clientID) {
		return errors.New("terminal_invalid_client_id")
	}
	return m.inputClient(id, clientID, data)
}
func (m *Manager) inputClient(id, clientID string, data []byte) error {
	if len(data) < 1 || len(data) > 65536 {
		return errors.New("terminal_invalid_input_size")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, e := m.find(id)
	if e != nil {
		return e
	}
	if s.record.State != "running" || s.console == nil {
		return ErrUnknown
	}
	if clientID != "" && s.record.ClientID != clientID {
		return errors.New("terminal_client_replaced")
	}
	select {
	case s.input <- append([]byte(nil), data...):
		s.lastActivity = time.Now()
		return nil
	default:
		return ErrBackpressure
	}
}
func (m *Manager) Resize(id string, cols, rows uint16) error {
	return m.resizeClient(id, "", cols, rows)
}
func (m *Manager) ResizeClient(id, clientID string, cols, rows uint16) error {
	if !protocol.ValidID(clientID) {
		return errors.New("terminal_invalid_client_id")
	}
	return m.resizeClient(id, clientID, cols, rows)
}
func (m *Manager) resizeClient(id, clientID string, cols, rows uint16) error {
	if !dimensions(cols, rows) {
		return errors.New("terminal_invalid_dimensions")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, e := m.find(id)
	if e != nil {
		return e
	}
	if s.console == nil || s.record.State != "running" {
		return ErrUnknown
	}
	if clientID != "" && s.record.ClientID != clientID {
		return errors.New("terminal_client_replaced")
	}
	if e = s.console.Resize(cols, rows); e != nil {
		return e
	}
	s.record.Cols = cols
	s.record.Rows = rows
	s.lastActivity = time.Now()
	s.record.UpdatedAt = time.Now().UTC()
	return m.persist(s)
}
func (m *Manager) Detach(id string) error {
	return m.DetachClient(id, "legacy")
}
func (m *Manager) DetachClient(id, clientID string) error {
	if !protocol.ValidID(clientID) {
		return errors.New("terminal_invalid_client_id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, e := m.find(id)
	if e != nil {
		return e
	}
	if s.record.State != "running" {
		return nil
	}
	if s.record.ClientID != clientID {
		return nil
	} // stale socket cannot detach its replacement
	s.record.State = "detached"
	s.record.ClientID = ""
	s.record.Reason = "client_detached_writer_retained"
	s.record.DetachedAt = time.Now().UTC()
	s.record.UpdatedAt = s.record.DetachedAt
	return m.persist(s)
}
func (m *Manager) Cancel(ctx context.Context, id string) (Record, error) {
	m.mu.Lock()
	s, e := m.find(id)
	if e != nil {
		m.mu.Unlock()
		return Record{}, e
	}
	if s.record.State == "exited" {
		rec := s.record
		m.mu.Unlock()
		return rec, nil
	}
	s.record.State = "cancelling"
	s.record.Reason = "console_cancellation_requested"
	s.record.UpdatedAt = time.Now().UTC()
	if e = m.persist(s); e != nil {
		m.mu.Unlock()
		return Record{}, e
	}
	nativeRecord := s.record.Native
	m.mu.Unlock()
	if nativeRecord.InvocationID == "" {
		return m.record(id), ErrUnknown
	}
	if e = m.backend.Cancel(ctx, nativeRecord); e != nil {
		return m.record(id), e
	}
	return m.Inspect(ctx, id)
}
func (m *Manager) record(id string) Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id].record
}
func (m *Manager) Inspect(ctx context.Context, id string) (Record, error) {
	m.mu.Lock()
	s, e := m.find(id)
	m.mu.Unlock()
	if e != nil {
		return Record{}, e
	}
	s.inspectMu.Lock()
	defer s.inspectMu.Unlock()
	m.mu.Lock()
	if e != nil {
		m.mu.Unlock()
		return Record{}, e
	}
	if s.record.State == "exited" {
		rec := s.record
		if !s.released {
			e = m.config.Release(rec)
			if e == nil {
				s.released = true
			}
		}
		m.mu.Unlock()
		return rec, e
	}
	nativeRecord := s.record.Native
	m.mu.Unlock()
	if nativeRecord.InvocationID == "" {
		return m.record(id), ErrUnknown
	}
	status, e := m.backend.Inspect(ctx, nativeRecord)
	flushIncomplete := false
	if e == nil && status.Exists && status.IdentityVerified && !status.Running {
		m.mu.Lock()
		console := s.console
		s.console = nil
		if !s.stopped {
			close(s.stop)
			s.stopped = true
		}
		done := s.outputDone
		m.mu.Unlock()
		if console != nil {
			closed := make(chan struct{})
			go func() {
				if finisher, ok := console.(interface{ Finish() error }); ok {
					finisher.Finish()
				}
				close(closed)
			}()
			select {
			case <-closed:
			case <-time.After(2 * time.Second):
				flushIncomplete = true
			}
		}
		if done != nil {
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				flushIncomplete = true
			}
		}
		if console != nil {
			go console.Close()
		}
	}
	m.mu.Lock()
	s = m.sessions[id]
	var closeConsole native.Terminal
	defer func() {
		m.mu.Unlock()
		if closeConsole != nil {
			closeConsole.Close()
		}
	}()
	if e != nil || !status.Exists || !status.IdentityVerified {
		s.record.State = "outcome_unknown"
		s.record.Reason = "containment_unconfirmed_writer_retained"
		m.persist(s)
		if e == nil {
			e = ErrUnknown
		}
		return s.record, e
	}
	if !status.Running {
		s.record.State = "exited"
		s.record.Reason = status.Reason
		if flushIncomplete {
			s.record.Reason = "process_exited_output_flush_incomplete"
		}
		if status.ExitCodeUnknown {
			s.record.ExitCode = nil
		} else {
			s.record.ExitCode = &status.ExitCode
		}
		s.record.UpdatedAt = time.Now().UTC()
		if e = m.persist(s); e != nil {
			s.record.State = "outcome_unknown"
			s.record.Reason = "exit_journal_unavailable_writer_retained"
			return s.record, e
		}
		if !s.stopped {
			close(s.stop)
			s.stopped = true
			closeConsole = s.console
			s.console = nil
		}
		if s.transcript != nil {
			s.transcript.Sync()
			s.transcript.Close()
			s.transcript = nil
		}
		if e = m.config.Release(s.record); e == nil {
			s.released = true
		}
		return s.record, e
	}
	if s.console == nil {
		s.record.State = "outcome_unknown"
		s.record.Reason = "live_containment_without_pty_endpoint"
		m.persist(s)
		return s.record, ErrUnknown
	}
	if s.record.State == "outcome_unknown" {
		s.record.State = "running"
		if !s.record.DetachedAt.IsZero() {
			s.record.State = "detached"
		}
		s.record.Reason = "original_containment_verified"
		s.record.UpdatedAt = time.Now().UTC()
		if e = m.persist(s); e != nil {
			return s.record, e
		}
	}
	return s.record, nil
}
func (m *Manager) List() []Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Record, 0, len(m.sessions))
	for _, s := range m.sessions {
		out = append(out, s.record)
	}
	return out
}
func (m *Manager) monitor() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-m.done:
			return
		case <-ticker.C:
		}
		for _, rec := range m.List() {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			_, _ = m.Inspect(ctx, rec.ID)
			cancel()
			m.mu.Lock()
			s := m.sessions[rec.ID]
			expired := s.record.State == "detached" && time.Since(s.record.DetachedAt) > time.Duration(m.config.GraceSeconds)*time.Second
			idle := (s.record.State == "running" || s.record.State == "detached") && time.Since(s.lastActivity) > time.Duration(m.config.IdleSeconds)*time.Second
			m.mu.Unlock()
			if expired || idle {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				_, _ = m.Cancel(ctx, rec.ID)
				cancel()
			}
		}
	}
}

// Close stops supervision endpoint ownership, never releases an unconfirmed
// writer. OS lifetimes are reconciled from persisted containment records.
func (m *Manager) Close() error {
	m.closeOnce.Do(func() {
		close(m.done)
		m.mu.Lock()
		m.closed = true
		var consoles []native.Terminal
		for _, s := range m.sessions {
			if s.record.State != "exited" {
				s.record.State = "outcome_unknown"
				s.record.Reason = "supervisor_endpoint_closed_writer_retained"
				m.persist(s)
			}
			if !s.stopped {
				close(s.stop)
				s.stopped = true
			}
			if s.console != nil {
				consoles = append(consoles, s.console)
				s.console = nil
			}
			if s.transcript != nil {
				s.transcript.Sync()
				s.transcript.Close()
				s.transcript = nil
			}
		}
		m.mu.Unlock()
		for _, c := range consoles {
			c.Close()
		}
	})
	return nil
}
