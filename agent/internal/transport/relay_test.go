package transport

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"homelab/agent/internal/files"
	"homelab/agent/internal/protocol"
	"homelab/agent/internal/supervisor"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSignedRPCPreventsBypassTamperAndReplay(t *testing.T) {
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	verifier, e := NewRPCVerifier("test", string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})))
	if e != nil {
		t.Fatal(e)
	}
	verifier.DispatchEpoch = "epoch"
	j, e := supervisor.OpenJournal(filepath.Join(t.TempDir(), "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	store, e := OpenRelayStore(j.DB())
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	root, e := files.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	local := Local{Supervisor: &supervisor.Service{Journal: j, Config: supervisor.Config{MachineID: "machine", Workspaces: []supervisor.Workspace{{ID: "workspace", Root: dir}}}}, Token: strings.Repeat("a", 40), Verifier: verifier, Relay: store, RequireSignedRPC: true, Roots: map[string]*files.Root{"workspace": root}, Writable: map[string]bool{"workspace": true}}
	handler := local.Handler()
	raw := `{"path":"created.txt","content_base64":"aGVsbG8=","expected_sha256":null}`
	r := RPCRequest{SchemaVersion: 1, ID: "request", MachineID: "machine", Method: "PUT", Path: "/v1/workspaces/workspace/files", Body: json.RawMessage(raw), CreatedAt: time.Now().UTC().Format(time.RFC3339), ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339), DispatchEpoch: "epoch"}
	canonical, _ := protocol.CanonicalJSON(r)
	r.Authorization = &RPCAuthorization{KeyID: "test", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, canonical))}
	signed, _ := json.Marshal(r)
	invoke := func(path string, payload string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", path, strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+local.Token)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, req)
		return out
	}
	if out := invoke("/v1/rpc", string(signed)); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	if out := invoke("/v1/rpc", string(signed)); out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	logs, e := store.Inspect("request")
	if e != nil || logs["state"] != "completed" {
		t.Fatal(logs, e)
	}
	data, e := root.Read("created.txt")
	if e != nil || string(data) != "hello" {
		t.Fatal(string(data), e)
	}
	r.Body = json.RawMessage(`{"path":"evil.txt","content_base64":"eA==","expected_sha256":null}`)
	tampered, _ := json.Marshal(r)
	if out := invoke("/v1/rpc", string(tampered)); out.Code == 200 {
		t.Fatal("tampered signature accepted")
	}
	req := httptest.NewRequest("PUT", "/v1/workspaces/workspace/files", strings.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+local.Token)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != 403 {
		t.Fatal("signed boundary bypass", rr.Code)
	}
	if _, e = store.Execute(context.Background(), RPCRequest{SchemaVersion: 1, ID: "expired", MachineID: "machine", Method: "GET", Path: "/v1/health", ExpiresAt: time.Now().Add(-time.Minute).Format(time.RFC3339)}, "machine", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("expired request ran") }), ""); e == nil {
		t.Fatal("expiry ignored")
	}
}
