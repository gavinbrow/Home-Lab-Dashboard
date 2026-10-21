package terminal

import (
	"context"
	"runtime"
	"testing"
)

var strongBootOld = "osboot-v1:" + runtime.GOOS + ":11111111-1111-1111-1111-111111111111"
var strongBootNew = "osboot-v1:" + runtime.GOOS + ":22222222-2222-2222-2222-222222222222"

func TestTrustedBootChangeReleasesOnlyRecoveredPriorBootSession(t *testing.T) {
	c, b, _, released := fixture(t)
	c.BootID = strongBootOld
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	rec, e := m.Start(context.Background(), request(t, "boot-session"))
	if e != nil {
		t.Fatal(e)
	}
	if rec.BootID != strongBootOld {
		t.Fatal("launch boot snapshot not captured")
	}
	m.Close()
	if released.Load() != 0 {
		t.Fatal("endpoint closure released unknown writer")
	}
	c.BootID = strongBootNew
	recovered, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer recovered.Close()
	for _, ids := range [][2]string{{"", strongBootNew}, {strongBootOld, ""}, {strongBootOld, strongBootOld}, {"wrong-old", strongBootNew}, {strongBootOld, "untrusted-new"}} {
		if _, e = recovered.ConfirmHostBootChanged(rec.ID, ids[0], ids[1]); e == nil {
			t.Fatal("accepted unbound boot assertion", ids)
		}
		if released.Load() != 0 {
			t.Fatal("invalid boot assertion released writer")
		}
	}
	// Even a matching assertion cannot override a live endpoint. This is a
	// defensive invariant for trusted caller mistakes, not a simulated OS reboot.
	recovered.mu.Lock()
	recovered.sessions[rec.ID].console = b.console
	recovered.mu.Unlock()
	if _, e = recovered.ConfirmHostBootChanged(rec.ID, strongBootOld, strongBootNew); e == nil {
		t.Fatal("released a session with a live endpoint")
	}
	recovered.mu.Lock()
	recovered.sessions[rec.ID].console = nil
	recovered.mu.Unlock()
	result, e := recovered.ConfirmHostBootChanged(rec.ID, strongBootOld, strongBootNew)
	if e != nil || result.State != "exited" || result.Reason != "host_boot_changed" || result.ExitCode != nil || released.Load() != 1 {
		t.Fatal("trusted prior-boot recovery did not establish interruption", result, e)
	}
	if _, e = recovered.ConfirmHostBootChanged(rec.ID, strongBootOld, strongBootNew); e != nil || released.Load() != 1 {
		t.Fatal("boot recovery was not idempotent", e)
	}
	current, e := recovered.Start(context.Background(), request(t, "current-boot"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = recovered.ConfirmHostBootChanged(current.ID, strongBootOld, strongBootNew); e == nil || released.Load() != 1 {
		t.Fatal("old boot proof released current-boot writer")
	}
}

func TestBootChangeDoesNotInferLegacyOrContainerRuntimeDeath(t *testing.T) {
	for _, kind := range []string{"legacy", "container"} {
		t.Run(kind, func(t *testing.T) {
			c, b, _, released := fixture(t)
			if kind != "legacy" {
				c.BootID = strongBootOld
			}
			m, e := newManager(c, b)
			if e != nil {
				t.Fatal(e)
			}
			rec, e := m.Start(context.Background(), request(t, "unconfirmed-boot"))
			if e != nil {
				t.Fatal(e)
			}
			m.Close()
			c.BootID = strongBootNew
			if kind == "container" {
				c.Container = &ContainerConfig{}
			}
			recovered, e := newManager(c, b)
			if e != nil {
				t.Fatal(e)
			}
			defer recovered.Close()
			if _, e = recovered.ConfirmHostBootChanged(rec.ID, strongBootOld, strongBootNew); e == nil || released.Load() != 0 {
				t.Fatal("boot-only assertion released unproven runtime", kind, e)
			}
		})
	}
}

func TestLegacyClockShiftCannotReleaseRecoveredLiveWriter(t *testing.T) {
	for _, ids := range [][2]string{{"machine:1792554100", "machine:1792554101"}, {"machine:1792554100", strongBootNew}, {strongBootOld, "machine:1792554101"}, {strongBootOld, ""}} {
		t.Run(ids[0]+"_to_"+ids[1], func(t *testing.T) {
			c, b, _, released := fixture(t)
			c.BootID = ids[0]
			m, e := newManager(c, b)
			if e != nil {
				t.Fatal(e)
			}
			rec, e := m.Start(context.Background(), request(t, "clock-shift"))
			if e != nil {
				t.Fatal(e)
			}
			m.Close()
			c.BootID = ids[1]
			recovered, e := newManager(c, b)
			if e != nil {
				t.Fatal(e)
			}
			defer recovered.Close()
			if _, e = recovered.ConfirmHostBootChanged(rec.ID, ids[0], ids[1]); e == nil {
				t.Fatal("clock estimate/unknown query became process-death proof")
			}
			b.mu.Lock()
			running := b.running
			b.mu.Unlock()
			if !running || released.Load() != 0 {
				t.Fatal("weak boot mismatch released a still-running process writer")
			}
			if _, e = recovered.Start(context.Background(), request(t, "forbidden-replacement")); e == nil {
				t.Fatal("second writer admitted after weak boot proof")
			}
		})
	}
}
