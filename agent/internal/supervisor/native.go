package supervisor

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"time"

	"homelab/agent/internal/native"
	"homelab/agent/internal/protocol"
)

func nativeSpec(r protocol.Request, w Workspace) native.Spec {
	policy := w.NativeNetworkPolicy
	if r.NetworkPolicy != nil && r.NetworkPolicy.Mode == "deny" {
		policy = "none"
	}
	return native.Spec{ID: r.OperationID, Command: r.Command.Executable, Args: r.Command.Args, Cwd: r.Command.Cwd, Env: r.Command.Env, NetworkPolicy: policy, Limits: native.Limits{TimeoutSeconds: min(r.Limits.PerCommandTimeoutSeconds, r.Limits.WallTimeSeconds), MaxOutputBytes: r.Limits.MaxOutputBytes, MemoryBytes: w.MemoryBytes, Pids: w.PidsLimit, CPUPercent: min(100, int(w.CPUs*100))}}
}
func (s *Service) nativeRunner(w Workspace) (*native.Runner, error) {
	if w.Native == nil || w.Native.Root != w.Root {
		return nil, errors.New("native_identity_configuration_required")
	}
	if s.nativeRunners == nil {
		s.nativeRunners = map[string]*native.Runner{}
		s.nativeConfigs = map[string]native.Config{}
	}
	if r := s.nativeRunners[w.ID]; r != nil && s.nativeConfigs[w.ID] == *w.Native {
		return r, nil
	}
	runner, e := native.New(*w.Native)
	if e != nil {
		return nil, e
	}
	s.nativeRunners[w.ID] = runner
	s.nativeConfigs[w.ID] = *w.Native
	return runner, nil
}
func (s *Service) tickNative(ctx context.Context, r Record, w Workspace) error {
	if native.KernelBootChanged(r.Receipt.BootID, s.BootID) {
		_, e := s.Journal.Update(r, "interrupted", "host_boot_changed_native_execution_ended", nil)
		return e
	}
	runner, e := s.nativeRunner(w)
	if e != nil {
		if r.Receipt.State == "received" {
			_, e = s.Journal.Update(r, "rejected", "native_identity_configuration_unavailable", nil)
			return e
		}
		return nil
	}
	var rec native.Record
	if r.Receipt.State == "received" {
		if time.Now().After(r.Deadline) {
			_, e = s.Journal.Update(r, "interrupted", "dispatch_deadline_expired_before_launch", nil)
			return e
		}
		if e = s.Authorize(r.Request); e != nil {
			_, e = s.Journal.Update(r, "rejected", e.Error(), nil)
			return e
		}
		r, e = s.Journal.Update(r, "launching", "native_launch_in_progress", nil)
		if e != nil {
			return e
		}
		spec := nativeSpec(r.Request, w)
		spec.Limits.TimeoutSeconds = min(spec.Limits.TimeoutSeconds, max(1, int(math.Ceil(time.Until(r.Deadline).Seconds()))))
		rec, e = runner.Launch(ctx, spec)
		if e != nil {
			_, e = s.Journal.Update(r, "outcome_unknown", "native_launch_ack_unknown_no_replay", nil)
			return e
		}
		raw, e := json.Marshal(rec)
		if e != nil {
			return e
		}
		if _, e = s.Journal.DB().Exec(`INSERT INTO native_runtime(operation,record)VALUES(?,?)`, r.Request.OperationID, raw); e != nil {
			return e
		}
		pid := int(rec.PID)
		r.Receipt.ProcessID = &pid
		r, e = s.Journal.Update(r, "running", "native_identity_and_containment_verified", nil)
		if e != nil {
			return e
		}
	} else {
		var raw []byte
		e = s.Journal.DB().QueryRow(`SELECT record FROM native_runtime WHERE operation=?`, r.Request.OperationID).Scan(&raw)
		if e == sql.ErrNoRows {
			if r.Receipt.State != "outcome_unknown" {
				_, e = s.Journal.Update(r, "outcome_unknown", "native_launch_record_missing_no_replay", nil)
				return e
			}
			return nil
		}
		if e != nil {
			return e
		}
		if e = json.Unmarshal(raw, &rec); e != nil {
			return e
		}
	}
	status, e := runner.Inspect(ctx, rec)
	if e != nil || !status.IdentityVerified {
		if r.Receipt.State != "outcome_unknown" {
			_, e = s.Journal.Update(r, "outcome_unknown", "native_identity_or_outcome_unconfirmed", nil)
			return e
		}
		return nil
	}
	if status.Running && (r.Receipt.State == "cancelling" || time.Now().After(r.Deadline)) {
		if e = runner.Cancel(ctx, rec); e != nil {
			return nil
		}
		status, e = runner.Inspect(ctx, rec)
		if e != nil || status.Running || !status.IdentityVerified {
			return nil
		}
	}
	b, truncated, e := runner.ReadLogs(ctx, rec, r.Request.Limits.MaxOutputBytes)
	if e == nil {
		if e = s.storeLogs(r, b, truncated); e != nil {
			return e
		}
	}
	if !status.Running {
		state, reason := "succeeded", "native_process_exited"
		if status.Reason != "" && status.Reason != "success" {
			reason = "native_containment_" + status.Reason
		}
		if status.ExitCode != 0 {
			state = "failed"
		}
		if r.Receipt.State == "cancelling" {
			state = "cancelled"
			reason = "native_containment_termination_verified"
		} else if time.Now().After(r.Deadline) {
			state = "failed"
			reason = "native_command_timeout"
		}
		if !status.Exists {
			state = "interrupted"
			reason = "native_containment_missing"
		}
		_, e = s.Journal.Update(r, state, reason, &status.ExitCode)
		return e
	}
	return nil
}
func (s *Service) storeLogs(r Record, b []byte, truncated bool) error {
	var offset int64
	e := s.Journal.DB().QueryRow(`SELECT COALESCE(SUM(length(data)),0) FROM logs WHERE operation=? AND truncated=0`, r.Request.OperationID).Scan(&offset)
	if e != nil {
		return e
	}
	for int(offset) < len(b) {
		end := min(int(offset)+16384, len(b))
		if e = s.Journal.AppendLog(r.Request.OperationID, "combined", string(b[offset:end]), false); e != nil {
			return e
		}
		offset = int64(end)
	}
	if truncated {
		var count int
		if e = s.Journal.DB().QueryRow(`SELECT COUNT(*) FROM logs WHERE operation=? AND truncated=1`, r.Request.OperationID).Scan(&count); e != nil {
			return e
		}
		if count == 0 {
			return s.Journal.AppendLog(r.Request.OperationID, "system", "output_truncated_at_host_quota", true)
		}
	}
	return nil
}
