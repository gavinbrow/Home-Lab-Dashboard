//go:build linux

package terminal

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestContainerSnapshotRejectsIdentityAndBoundaryDrift(t *testing.T) {
	b := &containerBackend{config: ContainerConfig{MachineID: "machine", WorkspaceID: "workspace", User: "65534:65534", ImageDigest: "trusted@sha256:" + strings.Repeat("a", 64), Root: "/srv/approved-project", CPUs: .25, MemoryBytes: 64 << 20, PidsLimit: 32}}
	var v containerSnapshot
	raw := `{"Id":"` + strings.Repeat("b", 64) + `","Config":{"User":"65534:65534","Image":"` + b.config.ImageDigest + `","Labels":{"homelab.machine_id":"machine","homelab.workspace_id":"workspace"}},"HostConfig":{"ReadonlyRootfs":true,"CapDrop":["ALL"],"NetworkMode":"none","SecurityOpt":["no-new-privileges"],"Memory":67108864,"NanoCpus":250000000,"PidsLimit":32},"Mounts":[{"Type":"bind","Source":"/srv/approved-project","Destination":"/workspace/project","RW":true}]}`
	if e := json.Unmarshal([]byte(raw), &v); e != nil {
		t.Fatal(e)
	}
	if _, e := b.verifySnapshot(v); e != nil {
		t.Fatal(e)
	}
	t.Run("no new privileges enabled forms only", func(t *testing.T) {
		cases := []struct {
			name string
			opts []string
			want bool
		}{
			{"bare", []string{"no-new-privileges"}, true},
			{"explicit true", []string{"no-new-privileges:true"}, true},
			{"equals true", []string{"no-new-privileges=true"}, true},
			{"both enabled", []string{"no-new-privileges", "no-new-privileges:true"}, false},
			{"duplicate enabled", []string{"no-new-privileges:true", "no-new-privileges:true"}, false},
			{"missing", nil, false},
			{"false", []string{"no-new-privileges:false"}, false},
			{"empty", []string{"no-new-privileges:"}, false},
			{"malformed", []string{"no-new-privileges:yes"}, false},
			{"conflicting after", []string{"no-new-privileges:true", "no-new-privileges:false"}, false},
			{"conflicting before", []string{"no-new-privileges:false", "no-new-privileges"}, false},
			{"malformed alongside enabled", []string{"no-new-privileges", "no-new-privileges:TRUE"}, false},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				var changed containerSnapshot
				if err := json.Unmarshal([]byte(raw), &changed); err != nil {
					t.Fatal(err)
				}
				changed.HostConfig.SecurityOpt = tc.opts
				_, err := b.verifySnapshot(changed)
				if (err == nil) != tc.want {
					t.Fatalf("accepted=%v, want %v: %v", err == nil, tc.want, err)
				}
			})
		}
	})
	cases := map[string]func(*containerSnapshot){"root identity": func(v *containerSnapshot) { v.Config.User = "0:0" }, "other workspace": func(v *containerSnapshot) { v.Config.Labels["homelab.workspace_id"] = "other" }, "privileged": func(v *containerSnapshot) { v.HostConfig.Privileged = true }, "host network": func(v *containerSnapshot) { v.HostConfig.NetworkMode = "host" }, "host pid": func(v *containerSnapshot) { v.HostConfig.PidMode = "host" }, "unconfined": func(v *containerSnapshot) {
		v.HostConfig.SecurityOpt = append(v.HostConfig.SecurityOpt, "seccomp=unconfined")
	}, "wrong mount": func(v *containerSnapshot) { v.Mounts[0].Source = "/var/run/docker.sock" }, "resource increase": func(v *containerSnapshot) { v.HostConfig.Memory = 128 << 20 }}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			var changed containerSnapshot
			json.Unmarshal([]byte(raw), &changed)
			mutate(&changed)
			if _, e := b.verifySnapshot(changed); e == nil {
				t.Fatal("accepted changed isolation/identity")
			}
		})
	}
	v.HostConfig.IpcMode = "container:unrelated"
	if _, e := b.verifySnapshot(v); e == nil {
		t.Fatal("accepted another container's IPC namespace")
	}
}
func TestContainerResponseBufferIsBounded(t *testing.T) {
	w := &limitedOutput{limit: 1024}
	data := make([]byte, 16384)
	n, e := w.Write(data)
	if e != nil || n != len(data) || !w.overflow || len(w.data) != 1024 {
		t.Fatal("command response buffer unbounded")
	}
}
