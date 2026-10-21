package terminal

import (
	"errors"
	"homelab/agent/internal/native"
	"time"
)

// ConfirmHostBootChanged is a local host-supervisor recovery action, never an
// RPC assertion. The caller must bind oldBoot to its protected operation journal
// and newBoot to the actual kernel boot identity used to configure this Manager.
// A process from a prior kernel boot cannot survive on that same native host.
func (m *Manager) ConfirmHostBootChanged(id, oldBoot, newBoot string) (Record, error) {
	m.mu.Lock()
	s, e := m.find(id)
	m.mu.Unlock()
	if e != nil {
		return Record{}, e
	}
	s.inspectMu.Lock()
	defer s.inspectMu.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if !native.KernelBootChanged(oldBoot, newBoot) || newBoot != m.config.BootID || oldBoot != s.record.BootID {
		return Record{}, errors.New("terminal_trusted_boot_change_not_established")
	}
	if s.console != nil || s.record.State == "running" || s.record.State == "detached" || s.record.State == "launching" {
		return Record{}, errors.New("terminal_live_endpoint_prevents_boot_recovery")
	}
	if s.record.State == "exited" {
		if s.record.Reason != "host_boot_changed" {
			return Record{}, errors.New("terminal_prior_result_immutable")
		}
		if !s.released {
			if e = m.config.Release(s.record); e != nil {
				return s.record, e
			}
			s.released = true
		}
		return s.record, nil
	}
	if m.config.Container != nil {
		return Record{}, errors.New("terminal_container_boot_change_requires_runtime_reconciliation")
	}
	// A remote Docker daemon/runtime may survive this machine's reboot, so the
	// boot-only proof applies to native processes on this same enrolled host.
	s.record.State = "exited"
	s.record.Reason = "host_boot_changed"
	s.record.ExitCode = nil
	s.record.ClientID = ""
	s.record.UpdatedAt = time.Now().UTC()
	if e = m.persist(s); e != nil {
		s.record.State = "outcome_unknown"
		s.record.Reason = "boot_result_journal_unavailable_writer_retained"
		return s.record, e
	}
	if !s.stopped {
		close(s.stop)
		s.stopped = true
	}
	if e = m.config.Release(s.record); e != nil {
		return s.record, e
	}
	s.released = true
	return s.record, nil
}
