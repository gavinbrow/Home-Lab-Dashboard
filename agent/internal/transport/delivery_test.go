package transport

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"homelab/agent/internal/supervisor"
)

func TestLostACKConsumedCentral410DrainsWithoutMutationReplay(t *testing.T) {
	j, err := supervisor.OpenJournal(filepath.Join(t.TempDir(), "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	s, err := OpenRelayStore(j.DB())
	if err != nil {
		t.Fatal(err)
	}
	_, err = j.DB().Exec(`CREATE TABLE outbound_results(id TEXT PRIMARY KEY,body BLOB NOT NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	mutations := 0
	r := RPCRequest{SchemaVersion: 1, ID: "sensitive-input", MachineID: "machine", Method: "POST", Path: "/v1/terminals/session/input", ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339), Body: json.RawMessage(`{"data":"eA=="}`)}
	result, err := s.Execute(context.Background(), r, "machine", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { mutations++; w.Write([]byte(`{"accepted":true}`)) }), "token")
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(result)
	if _, err = j.DB().Exec(`INSERT INTO outbound_results VALUES(?,?)`, r.ID, payload); err != nil {
		t.Fatal(err)
	}
	centralCalls, acks := 0, 0
	central := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		centralCalls++
		if centralCalls == 1 {
			h := w.(http.Hijacker)
			c, _, _ := h.Hijack()
			c.Close()
			return
		}
		w.WriteHeader(410)
		w.Write([]byte(`{"error":{"code":"terminal_delivery_expired"}}`))
	}))
	defer central.Close()
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		acks++
		if req.URL.Path != "/v1/rpc-output-acks" {
			t.Error("wrong cleanup route")
		}
		if err := s.AcknowledgeOutput(r.ID); err != nil {
			t.Error(err)
		}
		w.Write([]byte(`{"accepted":true}`))
	}))
	defer local.Close()
	drain := func() error {
		return drainPendingResult(context.Background(), j.DB(), central.Client(), local.Client(), central.URL, local.URL, "token", result)
	}
	if drain() == nil {
		t.Fatal("lost ACK treated as delivery")
	}
	var count int
	j.DB().QueryRow(`SELECT count(*) FROM outbound_results`).Scan(&count)
	if count != 1 || acks != 0 {
		t.Fatal("ambiguous result lost before retry")
	}
	if err = drain(); err != nil {
		t.Fatal(err)
	}
	j.DB().QueryRow(`SELECT count(*) FROM outbound_results`).Scan(&count)
	if count != 0 || acks != 1 || mutations != 1 {
		t.Fatal("expired delivery pinned outbox or replayed mutation")
	}
	r.Body = json.RawMessage(`{"data":"eQ=="}`)
	got, err := s.Execute(context.Background(), r, "machine", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { mutations++ }), "token")
	if err != nil || got.Status != 410 || mutations != 1 {
		t.Fatal("expired ID replayed changed input", err)
	}
}

func TestLegacyUntypedReceiptsRedactedBeforeBackupOrReplay(t *testing.T) {
	j, err := supervisor.OpenJournal(filepath.Join(t.TempDir(), "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	_, err = j.DB().Exec(`CREATE TABLE rpc_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,method TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,result BLOB); INSERT INTO rpc_receipts VALUES('old','public-one-character-digest','POST','completed',200,'private-output-canary')`)
	if err != nil {
		t.Fatal(err)
	}
	s, err := OpenRelayStore(j.DB())
	if err != nil {
		t.Fatal(err)
	}
	var digest, state string
	var body []byte
	if err = j.DB().QueryRow(`SELECT digest,state,result FROM rpc_receipts WHERE id='old'`).Scan(&digest, &state, &body); err != nil {
		t.Fatal(err)
	}
	if digest != "legacy-expired" || state != "completed" || string(body) == "private-output-canary" {
		t.Fatal("legacy privacy evidence retained")
	}
	got, err := s.Execute(context.Background(), RPCRequest{SchemaVersion: 1, ID: "old", MachineID: "machine", Method: "POST", Path: "/v1/terminals/session/input", ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339), Body: json.RawMessage(`{"data":"different"}`)}, "machine", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("legacy mutation replay") }), "token")
	if err != nil || got.Status != 410 {
		t.Fatal("legacy tombstone not uniform", err)
	}
}

func TestTransientExpiryMetadataIsAuthenticated(t *testing.T) {
	c, err := newTransientCipher()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	c.now = func() time.Time { return now }
	raw, err := c.seal([]byte("private-output"), "id\x00GET\x00path\x00200")
	if err != nil {
		t.Fatal(err)
	}
	var v transientEnvelope
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	v.IssuedAt += int64(20 * time.Second)
	v.ExpiresAt += int64(20 * time.Second)
	tampered, _ := json.Marshal(v)
	c.now = func() time.Time { return now.Add(40 * time.Second) }
	if _, err = c.open(tampered, v.Scope); err == nil {
		t.Fatal("unauthenticated timestamp extension accepted")
	}
}

func TestLegacyPlaintextOutboxScrubbedBeforeUnavailableNetwork(t *testing.T) {
	j, err := supervisor.OpenJournal(filepath.Join(t.TempDir(), "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer j.Close()
	_, err = j.DB().Exec(`CREATE TABLE outbound_results(id TEXT PRIMARY KEY,body BLOB NOT NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	r := RPCResult{SchemaVersion: 1, MachineID: "machine", ID: "legacy", Status: 200, Body: json.RawMessage(`{"record":{"request":{"command":{"executable":"__workspace_terminal__"}}},"data":"PRIVATE_LEGACY_OUTPUT_CANARY"}`)}
	raw, _ := json.Marshal(r)
	j.DB().Exec(`INSERT INTO outbound_results VALUES(?,?)`, r.ID, raw)
	if err = scrubLegacyPendingOutputs(j.DB()); err != nil {
		t.Fatal(err)
	}
	var stored []byte
	j.DB().QueryRow(`SELECT body FROM outbound_results WHERE id=?`, r.ID).Scan(&stored)
	var clean RPCResult
	if json.Unmarshal(stored, &clean) != nil || clean.Status != 410 || string(clean.Body) != string(terminalOutputGap) {
		t.Fatal("offline legacy plaintext retained")
	}
	central := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer central.Close()
	if deliverPendingResult(context.Background(), central.Client(), central.URL, clean) == nil {
		t.Fatal("unavailable central acknowledged")
	}
	j.DB().QueryRow(`SELECT body FROM outbound_results WHERE id=?`, r.ID).Scan(&stored)
	if string(stored) != string(mustMarshalResult(t, clean)) {
		t.Fatal("network failure restored legacy output")
	}
}

func mustMarshalResult(t *testing.T, r RPCResult) []byte {
	t.Helper()
	b, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
