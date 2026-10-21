package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"homelab/agent/internal/protocol"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type RPCRequest struct {
	MachineIdentityGeneration string            `json:"machine_identity_generation,omitempty"`
	SchemaVersion             int               `json:"schema_version"`
	ID                        string            `json:"id"`
	MachineID                 string            `json:"machine_id"`
	Method                    string            `json:"method"`
	Path                      string            `json:"path"`
	Body                      json.RawMessage   `json:"body"`
	CreatedAt                 string            `json:"created_at"`
	ExpiresAt                 string            `json:"expires_at"`
	DispatchEpoch             string            `json:"dispatch_epoch"`
	Authorization             *RPCAuthorization `json:"authorization,omitempty"`
}
type RPCAuthorization struct {
	KeyID     string `json:"key_id"`
	Signature string `json:"signature"`
}
type RPCResult struct {
	SchemaVersion int             `json:"schema_version"`
	MachineID     string          `json:"machine_id"`
	ID            string          `json:"id"`
	Status        int             `json:"status"`
	Body          json.RawMessage `json:"body"`
}
type RelayStore struct {
	db        *sql.DB
	transient *transientCipher
}
type RPCVerifier struct {
	MachineIdentityGeneration string
	KeyID                     string
	PublicKey                 ed25519.PublicKey
	DispatchEpoch             string
}

func NewRPCVerifier(keyID, publicPEM string) (*RPCVerifier, error) {
	block, _ := pem.Decode([]byte(publicPEM))
	if block == nil {
		return nil, errors.New("invalid_dispatch_public_key")
	}
	key, e := x509.ParsePKIXPublicKey(block.Bytes)
	if e != nil {
		return nil, e
	}
	public, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("ed25519_dispatch_public_key_required")
	}
	return &RPCVerifier{KeyID: keyID, PublicKey: public}, nil
}
func (v *RPCVerifier) Verify(r RPCRequest) error {
	if v.MachineIdentityGeneration == "" && r.MachineIdentityGeneration != "" {
		return errors.New("machine_identity_generation_unconfigured_reenroll_or_trusted_rotation_required")
	}
	if r.MachineIdentityGeneration != v.MachineIdentityGeneration {
		return errors.New("machine_identity_generation_mismatch")
	}
	if v.DispatchEpoch == "" || r.DispatchEpoch != v.DispatchEpoch {
		return errors.New("dispatch_epoch_mismatch")
	}
	if r.Authorization == nil || r.Authorization.KeyID != v.KeyID {
		return errors.New("dispatch_signature_required")
	}
	signature, e := base64.StdEncoding.DecodeString(r.Authorization.Signature)
	if e != nil {
		return errors.New("invalid_dispatch_signature")
	}
	r.Authorization = nil
	canonical, e := protocol.CanonicalJSON(r)
	if e != nil {
		return e
	}
	if !ed25519.Verify(v.PublicKey, canonical, signature) {
		return errors.New("invalid_dispatch_signature")
	}
	return nil
}
func OpenRelayStore(db *sql.DB) (*RelayStore, error) {
	_, e := db.Exec(`CREATE TABLE IF NOT EXISTS rpc_receipts(id TEXT PRIMARY KEY,digest TEXT NOT NULL,method TEXT NOT NULL,state TEXT NOT NULL,status INTEGER,result BLOB);`)
	if e != nil {
		return nil, e
	}
	if _, e = db.Exec(`UPDATE rpc_receipts SET state='outcome_unknown' WHERE state='executing'`); e != nil {
		return nil, e
	}
	if _, e = db.Exec(`UPDATE rpc_receipts SET digest='legacy-expired',status=410,result=? WHERE digest NOT LIKE 'rpc-v2:%' AND digest NOT LIKE 'input-v1:%' AND digest NOT IN ('input-expired','legacy-expired')`, []byte(`{"error":{"code":"legacy_rpc_receipt_expired","message":"Legacy receipt fingerprints were redacted; inspect the durable operation with a new request ID."}}`)); e != nil {
		return nil, e
	}
	transient, e := newTransientCipher()
	if e != nil {
		return nil, e
	}
	store := &RelayStore{db: db, transient: transient}
	if e = store.ScrubTransientOutputs(); e != nil {
		return nil, e
	}
	return store, nil
}

func (s *RelayStore) Inspect(id string) (map[string]any, error) {
	var state string
	var status sql.NullInt64
	var body []byte
	e := s.db.QueryRow(`SELECT state,status,result FROM rpc_receipts WHERE id=?`, id).Scan(&state, &status, &body)
	if e == sql.ErrNoRows {
		return map[string]any{"id": id, "state": "not_found"}, nil
	}
	if e != nil {
		return nil, e
	}
	if state == "executing" {
		state = "running"
	}
	result := map[string]any{"id": id, "state": state}
	if state == "completed" {
		code, decoded := int(status.Int64), body
		if encryptedTerminalOutput(body) {
			code = 410
			decoded = terminalOutputGap
		}
		if !encryptedTerminalOutput(body) && terminalOutputBody(body) {
			code = 410
			decoded = terminalOutputGap
		}
		result["status"] = code
		result["body"] = json.RawMessage(decoded)
	}
	return result, nil
}

var rpcPath = regexp.MustCompile(`^/v1/(health|roots|host-state/(?:policy|captures(?:/[A-Za-z0-9_-]+(?:/chunks/[0-9]+|/ack)?)?)|terminals(?:/[A-Za-z0-9_-]+(?:/attach|/detach|/input|/resize|/cancel)?)?|journal/backup|identities(?:/[A-Za-z0-9_-]+/verify)?|rpc-receipts/[A-Za-z0-9_-]+|operations(?:/[A-Za-z0-9_-]+(?:/cancel|/logs)?)?|workspaces(?:/[A-Za-z0-9_-]+(?:/binding|/manifest|/recovery-manifest|/restore-stream|/uploads(?:/[A-Za-z0-9_-]+(?:/chunks|/complete)?)?|/files(?:/rename)?|/directories|/snapshot|/restore|/quarantine(?:/[A-Za-z0-9_-]+(?:/restore)?)?|/file-operations/[A-Za-z0-9_-]+(?:/reconcile)?|/data|/environment(?:/restart|/rebuild|/remove)?)?)?|targets(?:/[A-Za-z0-9_-]+(?:/actions(?:/[A-Za-z0-9_-]+(?:/cancel)?)?)?)?|backup)$`)

func AllowedRPC(r RPCRequest) bool {
	u, e := url.ParseRequestURI(r.Path)
	if e != nil || u.Host != "" || u.Scheme != "" || !rpcPath.MatchString(u.Path) {
		return false
	}
	if r.Method != "GET" && r.Method != "POST" && r.Method != "PUT" && r.Method != "DELETE" {
		return false
	}
	return true
}
func (s *RelayStore) Execute(ctx context.Context, r RPCRequest, machine string, local http.Handler, token string) (RPCResult, error) {
	result := RPCResult{SchemaVersion: 1, MachineID: machine, ID: r.ID}
	if r.SchemaVersion != 1 || r.MachineID != machine || !AllowedRPC(r) {
		return result, errors.New("relay_request_denied")
	}
	expiry, e := time.Parse(time.RFC3339, r.ExpiresAt)
	if e != nil || !expiry.After(time.Now()) {
		return result, errors.New("relay_request_expired")
	}
	raw, e := protocol.CanonicalJSON(r)
	if e != nil {
		return result, e
	}
	digest := sha256.Sum256(raw)
	hash := "rpc-v2:" + hex.EncodeToString(digest[:])
	if terminalInputRPC(r) {
		hash = s.transient.inputDigest(raw, strconv.FormatInt(s.transient.now().Add(terminalOutputTTL).UnixNano(), 10))
	}
	var old, state string
	var status sql.NullInt64
	var body []byte
	e = s.db.QueryRow(`SELECT digest,state,status,result FROM rpc_receipts WHERE id=?`, r.ID).Scan(&old, &state, &status, &body)
	if e == nil {
		if old == "legacy-expired" {
			result.Status = 410
			result.Body = json.RawMessage(`{"error":{"code":"legacy_rpc_receipt_expired","message":"This request ID cannot be replayed."}}`)
			return result, nil
		}
		if old == "input-expired" || strings.HasPrefix(old, "input-v1:") && !s.transient.inputReceiptActive(old) {
			if e = s.expireInput(r.ID); e != nil {
				return result, e
			}
			result.Status = 410
			result.Body = terminalInputGap
			return result, nil
		}
		if strings.HasPrefix(old, "input-v1:") {
			parts := strings.Split(old, ":")
			hash = s.transient.inputDigest(raw, parts[2])
		}
		if old != hash {
			return result, errors.New("relay_id_payload_conflict")
		}
		if state == "completed" && !bulkCipherRead(r) {
			code, decoded := s.readTransient(r.ID, int(status.Int64), body)
			if terminalOutputRPC(r) && code == 200 && !encryptedTerminalOutput(body) {
				code = 410
				decoded = terminalOutputGap
			}
			result.Status = code
			result.Body = decoded
			return result, nil
		}
		if r.Method != "GET" {
			result.Status = 409
			result.Body = json.RawMessage(`{"error":{"code":"outcome_unknown","message":"RPC execution was interrupted; inspect the original operation before any new mutation"}}`)
			if _, e = s.db.Exec(`UPDATE rpc_receipts SET state='completed',status=?,result=? WHERE id=?`, result.Status, []byte(result.Body), r.ID); e != nil {
				return result, e
			}
			return result, nil
		}
	} else if e != sql.ErrNoRows {
		return result, e
	} else {
		if _, e = s.db.Exec(`INSERT INTO rpc_receipts(id,digest,method,state)VALUES(?,?,?,'executing')`, r.ID, hash, r.Method); e != nil {
			return result, e
		}
	}
	req, e := http.NewRequestWithContext(ctx, r.Method, r.Path, bytes.NewReader(r.Body))
	if e != nil {
		return result, e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	recorder := &rpcRecorder{header: http.Header{}, max: 96 << 20}
	local.ServeHTTP(recorder, req)
	if recorder.overflow {
		return result, errors.New("relay_response_limit")
	}
	if recorder.status == 0 {
		recorder.status = 200
	}
	result.Status = recorder.status
	result.Body = recorder.body
	if !json.Valid(result.Body) {
		result.Status = 502
		result.Body = json.RawMessage(`{"error":{"code":"invalid_host_response","message":"Host response was not valid JSON"}}`)
	}
	stored := []byte(result.Body)
	if (terminalOutputRPC(r) || terminalOutputBody(result.Body)) && result.Status == 200 {
		stored, e = s.transient.seal(stored, transientScope(r.ID, r.Method, r.Path, result.Status))
		if e != nil {
			return result, e
		}
	}
	if bulkCipherRead(r) && result.Status == 200 {
		hash := sha256.Sum256(stored)
		stored, _ = json.Marshal(map[string]any{"bulk_response_omitted": true, "response_sha256": hex.EncodeToString(hash[:]), "size_bytes": len(stored), "retry": "immutable_ciphertext_chunk_only"})
	}
	_, e = s.db.Exec(`UPDATE rpc_receipts SET state='completed',status=?,result=? WHERE id=?`, result.Status, stored, r.ID)
	return result, e
}

type rpcRecorder struct {
	header   http.Header
	status   int
	body     []byte
	max      int
	overflow bool
}

func (r *rpcRecorder) Header() http.Header { return r.header }
func (r *rpcRecorder) WriteHeader(s int) {
	if r.status == 0 {
		r.status = s
	}
}
func (r *rpcRecorder) Write(b []byte) (int, error) {
	if len(r.body)+len(b) > r.max {
		r.overflow = true
		return 0, errors.New("response_limit")
	}
	r.body = append(r.body, b...)
	return len(b), nil
}

type relayStatusError struct{ Status int }

func (e *relayStatusError) Error() string { return "relay_server_rejected_request" }

func JSONRequest(ctx context.Context, client *http.Client, endpoint string, input, output any) error {
	u, e := url.Parse(endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("explicit_https_endpoint_required")
	}
	b, e := json.Marshal(input)
	if e != nil {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(b))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := client.Do(req)
	if e != nil {
		return errors.New("relay_transport_failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &relayStatusError{Status: resp.StatusCode}
	}
	data, e := io.ReadAll(io.LimitReader(resp.Body, 96<<20+1))
	if e != nil {
		return e
	}
	if len(data) > 96<<20 {
		return errors.New("relay_server_response_limit")
	}
	if output != nil {
		return json.Unmarshal(data, output)
	}
	return nil
}

// Ciphertext chunks are immutable while retained. Keep durable request/digest
// and response evidence without recursively archiving prior backup payloads.
// Repeating this GET re-reads the bounded ciphertext chunk, never a mutation.
func bulkCipherRead(r RPCRequest) bool {
	u, e := url.Parse(r.Path)
	return e == nil && r.Method == "GET" && strings.HasPrefix(u.Path, "/v1/host-state/captures/") && strings.Contains(u.Path, "/chunks/")
}
