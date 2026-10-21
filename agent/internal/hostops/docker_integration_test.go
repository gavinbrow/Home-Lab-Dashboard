//go:build linux

package hostops

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"homelab/agent/internal/files"
	"homelab/agent/internal/protocol"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDisposableDockerLifecycle opts in only to new containers with generated
// names. It never controls an existing user container or removes a volume.
func TestDisposableDockerLifecycle(t *testing.T) {
	image := os.Getenv("HLD_HOSTOPS_DOCKER_IMAGE")
	if image == "" {
		t.Skip("explicit disposable Docker integration opt-in required")
	}
	if !pinnedImage.MatchString(image) {
		t.Fatal("pinned image required")
	}
	m, r := testManager(t)
	_ = r
	var nonce [8]byte
	_, _ = rand.Read(nonce[:])
	name := "homelab-validation-hostops-" + hex.EncodeToString(nonce[:])
	envID := "11111111-2222-4333-8444-555555555555"
	gen := 1
	b, _ := m.binding("ws")
	b.Type = "container"
	b.RuntimePath = "/workspace/project"
	b.RuntimeID = name
	b.EnvironmentID = &envID
	b.EnvironmentGeneration = &gen
	b.ImageDigest = image
	b.ContainerUser = "10001:10001"
	b.CPUs = 1
	b.MemoryBytes = 128 << 20
	b.PidsLimit = 32
	b.EnvironmentGrantIDs = []string{"env-grant"}
	b.Command = []string{"/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"}
	m.config.DockerPath = "/usr/bin/docker"
	m.bindings.Store("ws", b)
	if e := os.Chmod(b.CanonicalRoot, 0777); e != nil {
		t.Fatal(e)
	}
	sentinel := []byte{0, 255, 1, 8}
	if _, e := r.Write("sentinel.bin", sentinel, nil); e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	args := []string{"run", "--detach", "--name", name, "--label", "homelab.machine_id=" + m.config.MachineID, "--label", "homelab.workspace_id=ws", "--user", b.ContainerUser, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=none", "--mount", "type=bind,source=" + b.CanonicalRoot + ",target=/workspace/project", image}
	args = append(args, b.Command...)
	if out, e := run(ctx, m.config.DockerPath, 1<<20, args...); e != nil {
		t.Fatal(out, e)
	}
	names := []string{name}
	defer func() {
		for _, n := range names {
			_, _ = run(context.Background(), m.config.DockerPath, 4096, "rm", "--force", n)
		}
	}()
	mux := http.NewServeMux()
	m.Register(mux)
	call := func(op, verb string, revision int) Receipt {
		body, _ := json.Marshal(map[string]any{"operation_id": op, "grant_id": "env-grant", "expected_revision": revision})
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/workspaces/ws/environment/"+verb, strings.NewReader(string(body))))
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var out Receipt
		if e := json.Unmarshal(rec.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		if out.State != "completed" {
			t.Fatal(out)
		}
		return out
	}
	call("docker-restart", "restart", 1)
	call("docker-rebuild", "rebuild", 1)
	next, _ := m.binding("ws")
	names = append(names, next.RuntimeID)
	if next.RuntimeID == name || next.EnvironmentID == nil || *next.EnvironmentID == envID || next.EnvironmentGeneration == nil || *next.EnvironmentGeneration != 2 || next.Revision != 2 {
		t.Fatal("environment identity not advanced", next)
	}
	if out, e := run(ctx, m.config.DockerPath, 4096, "inspect", name); e == nil {
		t.Fatal("old environment remains", out)
	}
	if e := m.verifyContainer(ctx, next.RuntimeID, "ws"); e != nil {
		t.Fatal(e)
	}
	bytes, e := os.ReadFile(filepath.Join(b.CanonicalRoot, "sentinel.bin"))
	if e != nil || files.Hash(bytes) != files.Hash(sentinel) {
		t.Fatal("rebuild lost persistent bytes", e)
	}
	m.config.Targets = []Target{{ID: "docker-target", Kind: "docker_container", Name: next.RuntimeID, AllowedOperations: []string{"status", "restart"}, GrantIDs: []string{"action-grant"}, PolicyRevision: 1}}
	action := func(op, verb string, fence int64) Receipt {
		q := map[string]any{"schema_version": 1, "operation_id": op, "job_id": "control-job", "machine_id": "machine", "target_id": "docker-target", "target_kind": "docker_container", "verb": verb, "grant_id": "action-grant", "policy_revision": 1, "fence": fence, "dispatch_epoch": "epoch", "max_log_bytes": 4096, "grant": protocol.Grant{ID: "action-grant", OwnerID: "owner", Revision: 1, Tools: []string{"actions.run"}, MachineIDs: []string{"machine"}, WorkspaceIDs: []string{}}}
		logical := map[string]any{}
		for k, v := range q {
			if k != "fence" && k != "dispatch_epoch" {
				logical[k] = v
			}
		}
		canonical, _ := protocol.CanonicalJSON(logical)
		q["request_hash"] = files.Hash(canonical)
		body, _ := json.Marshal(q)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/targets/docker-target/actions", strings.NewReader(string(body))))
		if rec.Code != 200 {
			t.Fatal(rec.Code, rec.Body.String())
		}
		var out Receipt
		if e := json.Unmarshal(rec.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		if out.State == "completed" && out.RequestHash != q["request_hash"] {
			t.Fatal("helper receipt hash mismatch", out)
		}
		return out
	}
	if out := action("control-restart", "restart", 2); out.State != "completed" {
		t.Fatal(out)
	}
	if out := action("control-status", "status", 2); out.State != "completed" {
		t.Fatal(out)
	} else if result, ok := out.Result.(map[string]any); !ok || result["status"] != "running" {
		t.Fatal("helper actual status unverified", out)
	}
	if out := action("control-stale", "restart", 1); out.State != "failed" || out.Reason != "stale_fence" {
		t.Fatal("stale helper fence accepted", out)
	}
	call("docker-remove", "remove", 2)
	if _, e := os.Stat(filepath.Join(b.CanonicalRoot, "sentinel.bin")); e != nil {
		t.Fatal("runtime removal deleted storage", e)
	}
	t.Logf("DOCKER_EVIDENCE old=%s replacement=%s generations=1->2 sentinel_sha256=%s persistent_root=%s restart/rebuild/remove/helper_restart/helper_status/stale_fence=passed", name, next.RuntimeID, files.Hash(sentinel), b.CanonicalRoot)
}
