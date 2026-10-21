package hostops

import (
	"encoding/json"
	"homelab/agent/internal/files"
	"homelab/agent/internal/protocol"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestActionInnerIdentityGenerationIsPinnedAndHashed(t *testing.T) {
	m, _ := testManager(t)
	m.config.MachineIdentityGeneration = "installed-generation"
	m.config.SystemctlPath = filepath.Join(t.TempDir(), "never-exists")
	m.config.Targets = []Target{{ID: "target", Kind: "systemd", Name: "owned-proof.service", AllowedOperations: []string{"status"}, GrantIDs: []string{"grant"}, PolicyRevision: 1}}
	mux := http.NewServeMux()
	m.Register(mux)
	for _, generation := range []string{"", "stale-generation", "installed-generation"} {
		q := map[string]any{"schema_version": 1, "operation_id": "generation-" + generation, "job_id": "job", "machine_id": "machine", "target_id": "target", "target_kind": "systemd", "verb": "status", "grant_id": "grant", "policy_revision": 1, "fence": 1, "dispatch_epoch": "epoch", "max_log_bytes": 4096, "grant": protocol.Grant{ID: "grant", OwnerID: "owner", Revision: 1, Tools: []string{"actions.run"}, MachineIDs: []string{"machine"}}}
		if generation != "" {
			q["machine_identity_generation"] = generation
		}
		logical := map[string]any{}
		for k, v := range q {
			if k != "fence" && k != "dispatch_epoch" {
				logical[k] = v
			}
		}
		canonical, _ := protocol.CanonicalJSON(logical)
		q["request_hash"] = files.Hash(canonical)
		body, _ := json.Marshal(q)
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest("POST", "/v1/targets/target/actions", strings.NewReader(string(body))))
		if generation != "installed-generation" {
			if out.Code != 403 {
				t.Fatal("unpinned generation accepted", generation, out.Code, out.Body.String())
			}
			continue
		}
		if out.Code != 200 {
			t.Fatal("correct generation rejected", out.Code, out.Body.String())
		}
		var receipt Receipt
		if e := json.Unmarshal(out.Body.Bytes(), &receipt); e != nil {
			t.Fatal(e)
		}
		if receipt.RequestHash != q["request_hash"] {
			t.Fatal("generation not preserved in logical receipt hash")
		}
	}
}
