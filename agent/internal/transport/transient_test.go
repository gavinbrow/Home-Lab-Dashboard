package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"homelab/agent/internal/supervisor"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTerminalTransientCacheLostACKExpiryRestartTamper(t *testing.T) {
	j, e := supervisor.OpenJournal(filepath.Join(t.TempDir(), "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	store, e := OpenRelayStore(j.DB())
	if e != nil {
		t.Fatal(e)
	}
	calls := 0
	body := []byte(`{"record":{"request":{"command":{"executable":"__workspace_terminal__"}}},"data":"PRIVATE_CONSOLE_CANARY"}`)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.Write(body)
	})
	request := RPCRequest{SchemaVersion: 1, ID: "attach1", MachineID: "machine", Method: "POST", Path: "/v1/terminals/session/attach", ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339), Body: json.RawMessage(`{"client_id":"client"}`)}
	execute := func(s *RelayStore, r RPCRequest) RPCResult {
		t.Helper()
		value, e := s.Execute(context.Background(), r, "machine", handler, "token")
		if e != nil {
			t.Fatal(e)
		}
		return value
	}
	first := execute(store, request)
	if first.Status != 200 || !bytes.Contains(first.Body, []byte("PRIVATE_CONSOLE_CANARY")) {
		t.Fatal("firstoutputmissing")
	}
	var stored []byte
	if e = j.DB().QueryRow("SELECT result FROM rpc_receipts WHERE id=?", request.ID).Scan(&stored); e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(stored, []byte("PRIVATE_CONSOLE_CANARY")) || !encryptedTerminalOutput(stored) {
		t.Fatal("rawoutputpersisted")
	}
	inspected, e := store.Inspect(request.ID)
	if e != nil || inspected["status"] != 410 || bytes.Contains([]byte(string(inspected["body"].(json.RawMessage))), []byte("PRIVATE_CONSOLE_CANARY")) {
		t.Fatal("inspectionleakedtransientoutput", e)
	}
	again := execute(store, request)
	if calls != 1 || !bytes.Equal(again.Body, first.Body) {
		t.Fatal("lostACKreexecutedattach")
	}
	store.transient.now = func() time.Time { return time.Now().Add(31 * time.Second) }
	expired := execute(store, request)
	if expired.Status != 410 || !bytes.Contains(expired.Body, []byte("output_gap")) || calls != 1 {
		t.Fatal("expiryreexecutedattach")
	}
	if e = store.ScrubTransientOutputs(); e != nil {
		t.Fatal(e)
	}
	if e = j.DB().QueryRow("SELECT result FROM rpc_receipts WHERE id=?", request.ID).Scan(&stored); e != nil || encryptedTerminalOutput(stored) {
		t.Fatal("expirywasnotscrubbed", e)
	}
	store.transient.now = time.Now
	request.ID = "attach2"
	execute(store, request)
	restarted, e := OpenRelayStore(j.DB())
	if e != nil {
		t.Fatal(e)
	}
	if result := execute(restarted, request); result.Status != 410 || calls != 2 {
		t.Fatal("restartlostkeyreexecutedattach")
	}
	request.ID = "attach3"
	execute(store, request)
	if e = j.DB().QueryRow("SELECT result FROM rpc_receipts WHERE id=?", request.ID).Scan(&stored); e != nil {
		t.Fatal(e)
	}
	var envelope transientEnvelope
	if e = json.Unmarshal(stored, &envelope); e != nil {
		t.Fatal(e)
	}
	envelope.Ciphertext[0] ^= 1
	stored, _ = json.Marshal(envelope)
	if _, e = j.DB().Exec("UPDATE rpc_receipts SET result=? WHERE id=?", stored, request.ID); e != nil {
		t.Fatal(e)
	}
	if result := execute(store, request); result.Status != 410 || calls != 3 {
		t.Fatal("tamperreexecutedattach")
	}
	request.ID = "attach4"
	execute(store, request)
	if e = store.AcknowledgeOutput(request.ID); e != nil {
		t.Fatal(e)
	}
	if result := execute(store, request); result.Status != 410 || calls != 4 {
		t.Fatal("ACKtombstonereexecutedattach")
	}
}
func TestTerminalOutboxEncryptionTTLAndLostKey(t *testing.T) {
	cipher, e := newTransientCipher()
	if e != nil {
		t.Fatal(e)
	}
	r := RPCRequest{ID: "id", Method: "GET", Path: "/v1/terminals/id"}
	result := RPCResult{SchemaVersion: 1, ID: r.ID, MachineID: "machine", Status: 200, Body: json.RawMessage(`{"data":"PRIVATE_OUTBOX_CANARY"}`)}
	raw, e := encodePendingResult(cipher, r, result)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(raw, []byte("PRIVATE_OUTBOX_CANARY")) {
		t.Fatal("plaintextoutbox")
	}
	decoded, e := decodePendingResult(cipher, r.ID, "machine", raw)
	if e != nil || decoded.Status != 200 || !bytes.Equal(decoded.Body, result.Body) {
		t.Fatal("validpendingoutputlost", e)
	}
	other, _ := newTransientCipher()
	decoded, e = decodePendingResult(other, r.ID, "machine", raw)
	if e != nil || decoded.Status != 410 {
		t.Fatal("restartmustreturngap", e)
	}
	cipher.now = func() time.Time { return time.Now().Add(31 * time.Second) }
	decoded, e = decodePendingResult(cipher, r.ID, "machine", raw)
	if e != nil || decoded.Status != 410 {
		t.Fatal("TTLmustreturngap", e)
	}
	cipher.now = time.Now
	if _, e = decodePendingResult(cipher, "other-id", "machine", raw); e == nil {
		t.Fatal("swappedspoolidentityaccepted")
	}
}

func TestSensitiveInputUsesRAMKeyThenUniformIDOnlyTombstone(t *testing.T) {
	j, e := supervisor.OpenJournal(filepath.Join(t.TempDir(), "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	s, e := OpenRelayStore(j.DB())
	if e != nil {
		t.Fatal(e)
	}
	calls := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.Write([]byte(`{"accepted":true}`)) })
	r := RPCRequest{SchemaVersion: 1, ID: "input1", MachineID: "machine", Method: "POST", Path: "/v1/terminals/session/input", ExpiresAt: time.Now().Add(time.Hour).Format(time.RFC3339), Body: json.RawMessage(`{"client_id":"client","data":"eA=="}`)}
	run := func(store *RelayStore) RPCResult {
		v, e := store.Execute(context.Background(), r, "machine", handler, "token")
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	if run(s).Status != 200 {
		t.Fatal("inputnotaccepted")
	}
	var digest string
	if e = j.DB().QueryRow("SELECT digest FROM rpc_receipts WHERE id=?", r.ID).Scan(&digest); e != nil || !strings.HasPrefix(digest, "input-v1:") {
		t.Fatal("publicinputdigestpersisted", e)
	}
	if run(s).Status != 200 || calls != 1 {
		t.Fatal("lostACKreexecutedinput")
	}
	if e = s.AcknowledgeOutput(r.ID); e != nil {
		t.Fatal(e)
	}
	r.Body = json.RawMessage(`{"data":"different"}`)
	if run(s).Status != 410 || calls != 1 {
		t.Fatal("ACKIDtombstonewaspayloaddependent")
	}
	j.DB().QueryRow("SELECT digest FROM rpc_receipts WHERE id=?", r.ID).Scan(&digest)
	if digest != "input-expired" {
		t.Fatal("inputdigestnotredacted")
	}
	r.ID = "input2"
	if run(s).Status != 200 {
		t.Fatal("secondinputnotaccepted")
	}
	restarted, e := OpenRelayStore(j.DB())
	if e != nil {
		t.Fatal(e)
	}
	if run(restarted).Status != 410 || calls != 2 {
		t.Fatal("lostkeyreexecutedinput")
	}
	r.ID = "input3"
	if run(s).Status != 200 {
		t.Fatal("thirdinputnotaccepted")
	}
	s.transient.now = func() time.Time { return time.Now().Add(31 * time.Second) }
	if e = s.ScrubTransientOutputs(); e != nil {
		t.Fatal(e)
	}
	if run(s).Status != 410 || calls != 3 {
		t.Fatal("TTLreexecutedinput")
	}
}
