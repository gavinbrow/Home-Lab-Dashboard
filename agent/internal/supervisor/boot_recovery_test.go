package supervisor

import (
	"context"
	"runtime"
	"testing"

	"homelab/agent/internal/protocol"
)

func TestOnlyStrongSamePlatformBootChangeCanReleaseNativeWriter(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("native boot recovery supports Linux and Windows")
	}
	strong := "osboot-v1:" + runtime.GOOS + ":"
	old, current := strong+"11111111-1111-1111-1111-111111111111", strong+"22222222-2222-2222-2222-222222222222"
	for _, tc := range []struct {
		name, previous, now string
		release             bool
	}{
		{"legacy clock changed", "machine:100", "machine:200", false},
		{"legacy to strong", "machine:100", current, false},
		{"strong to legacy", old, "machine:200", false},
		{"query unavailable", old, "", false},
		{"legacy missing", "", current, false},
		{"same kernel", old, old, false},
		{"invalid identifier", old, strong + "00000000-0000-0000-0000-000000000000", false},
		{"confirmed different kernel", old, current, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			j, _ := journal(t)
			r := req()
			rec, _, err := j.Accept(r, tc.previous, "epoch")
			if err != nil {
				t.Fatal(err)
			}
			rec, err = j.Update(rec, "running", "existing native process", nil)
			if err != nil {
				t.Fatal(err)
			}
			s := Service{Journal: j, BootID: tc.now, Config: Config{Workspaces: []Workspace{{ID: r.WorkspaceID, NativeEnabled: true}}}}
			// No runner config: normal runtime inspection cannot prove an exit. The
			// only allowed terminal transition here is a strong changed-kernel proof.
			if err = s.tickNative(context.Background(), rec, s.Config.Workspaces[0]); err != nil {
				t.Fatal(err)
			}
			got, err := j.Get(r.OperationID)
			if err != nil {
				t.Fatal(err)
			}
			if protocol.Terminal(got.Receipt.State) != tc.release {
				t.Fatal("weak boot evidence changed native writer lifetime")
			}
			called := false
			err = s.WithWorkspaceWrite(r.WorkspaceID, func() error { called = true; return nil })
			if called != tc.release || (err == nil) != tc.release {
				t.Fatal("writer reservation released without proven termination")
			}
		})
	}
}
