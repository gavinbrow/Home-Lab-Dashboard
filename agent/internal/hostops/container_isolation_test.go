package hostops

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOwnedContainerInspectNoNewPrivilegesForms(t *testing.T) {
	m, _ := testManager(t)
	b, e := m.binding("ws")
	if e != nil {
		t.Fatal(e)
	}
	for _, test := range []struct {
		name    string
		opts    []string
		allowed bool
	}{
		{"bare", []string{"no-new-privileges"}, true},
		{"docker-inspect-explicit-true", []string{"no-new-privileges:true"}, true},
		{"documented-equals-true", []string{"no-new-privileges=true"}, true},
		{"missing", nil, false},
		{"false", []string{"no-new-privileges:false"}, false},
		{"equals-false", []string{"no-new-privileges=false"}, false},
		{"conflicting-enabled-then-disabled", []string{"no-new-privileges", "no-new-privileges:false"}, false},
		{"conflicting-disabled-then-enabled", []string{"no-new-privileges=false", "no-new-privileges:true"}, false},
		{"duplicate-enabled", []string{"no-new-privileges", "no-new-privileges:true"}, false},
		{"malformed-enabled", []string{"no-new-privileges", "no-new-privileges:true:false"}, false},
		{"ambiguous-case", []string{"no-new-privileges:TRUE"}, false},
		{"ambiguous-whitespace", []string{"no-new-privileges: true"}, false},
		{"unconfined-seccomp", []string{"no-new-privileges:true", "seccomp=unconfined"}, false},
		{"unconfined-apparmor", []string{"no-new-privileges", "apparmor:unconfined"}, false},
		{"unconfined-systempaths", []string{"no-new-privileges=true", "systempaths=unconfined"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			inspect := []any{map[string]any{"Id": strings.Repeat("c", 64), "Config": map[string]any{"User": "10001:10001", "Labels": map[string]string{"homelab.machine_id": "machine", "homelab.workspace_id": "ws"}}, "HostConfig": map[string]any{"ReadonlyRootfs": true, "CapDrop": []string{"ALL"}, "NetworkMode": "none", "SecurityOpt": test.opts}, "Mounts": []any{map[string]any{"Type": "bind", "Source": b.CanonicalRoot, "Destination": "/workspace/project"}}}}
			raw, e := json.Marshal(inspect)
			if e != nil {
				t.Fatal(e)
			}
			id, e := m.verifyContainerInspect(raw, "ws")
			if test.allowed {
				if e != nil || id != strings.Repeat("c", 64) {
					t.Fatal("enabled owned container rejected", id, e)
				}
			} else if e == nil || e.Error() != "environment_isolation_unverified" {
				t.Fatal("disabled/ambiguous isolation accepted", id, e)
			}
		})
	}
}
