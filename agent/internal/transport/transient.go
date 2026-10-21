package transport

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const terminalOutputTTL = 30 * time.Second

var terminalInputGap = json.RawMessage(`{"error":{"code":"terminal_input_expired","message":"The original input receipt expired; the same request ID cannot deliver input again."},"input_outcome_unknown":true}`)
var terminalOutputGap = json.RawMessage(`{"error":{"code":"terminal_output_expired","message":"Transient console output expired; request a new output range."},"output_gap":true}`)

type transientEnvelope struct {
	Version    int    `json:"_terminal_transient"`
	ExpiresAt  int64  `json:"expires_at"`
	IssuedAt   int64  `json:"issued_at"`
	Scope      string `json:"scope"`
	Nonce      []byte `json:"nonce"`
	Ciphertext []byte `json:"ciphertext"`
}
type transientCipher struct {
	aead      cipher.AEAD
	now       func() time.Time
	digestKey [32]byte
	session   string
}

func newTransientCipher() (*transientCipher, error) {
	var key [32]byte
	if _, e := rand.Read(key[:]); e != nil {
		return nil, e
	}
	block, e := aes.NewCipher(key[:])
	clear(key[:])
	if e != nil {
		return nil, e
	}
	aead, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	result := &transientCipher{aead: aead, now: time.Now}
	if _, e = rand.Read(result.digestKey[:]); e != nil {
		return nil, e
	}
	fingerprint := sha256.Sum256(result.digestKey[:])
	result.session = hex.EncodeToString(fingerprint[:8])
	return result, nil
}
func (t *transientCipher) seal(raw []byte, scope string) ([]byte, error) {
	if len(raw) > 2<<20 {
		return nil, errors.New("terminal_transient_output_limit")
	}
	nonce := make([]byte, t.aead.NonceSize())
	if _, e := rand.Read(nonce); e != nil {
		return nil, e
	}
	now := t.now()
	v := transientEnvelope{Version: 1, IssuedAt: now.UnixNano(), ExpiresAt: now.Add(terminalOutputTTL).UnixNano(), Scope: scope, Nonce: nonce}
	v.Ciphertext = t.aead.Seal(nil, nonce, raw, transientAAD(v))
	return json.Marshal(v)
}
func (t *transientCipher) open(raw []byte, scope string) ([]byte, error) {
	var v transientEnvelope
	if len(raw) > 3<<20 || json.Unmarshal(raw, &v) != nil || v.Version != 1 || v.Scope != scope || len(v.Nonce) != t.aead.NonceSize() {
		return nil, errors.New("terminal_output_expired")
	}
	now := t.now().UnixNano()
	if now < v.IssuedAt || now >= v.ExpiresAt || v.ExpiresAt-v.IssuedAt > int64(terminalOutputTTL) {
		return nil, errors.New("terminal_output_expired")
	}
	b, e := t.aead.Open(nil, v.Nonce, v.Ciphertext, transientAAD(v))
	if e != nil {
		return nil, errors.New("terminal_output_expired")
	}
	return b, nil
}
func transientAAD(v transientEnvelope) []byte {
	return []byte(fmt.Sprintf("%s\x00%d\x00%d\x00%d", v.Scope, v.Version, v.IssuedAt, v.ExpiresAt))
}
func transientScope(id, method, path string, status int) string {
	return fmt.Sprintf("%s\x00%s\x00%s\x00%d", id, method, path, status)
}
func terminalOutputRPC(r RPCRequest) bool {
	return strings.HasPrefix(r.Path, "/v1/terminals/") && (r.Method == "GET" || r.Method == "POST" && strings.HasSuffix(r.Path, "/attach"))
}
func encryptedTerminalOutput(raw []byte) bool {
	var v struct {
		Version int `json:"_terminal_transient"`
	}
	return json.Unmarshal(raw, &v) == nil && v.Version == 1
}
func (s *RelayStore) readTransient(id string, status int, body []byte) (int, []byte) {
	if !encryptedTerminalOutput(body) {
		return status, body
	}
	var v transientEnvelope
	if json.Unmarshal(body, &v) != nil || !strings.HasPrefix(v.Scope, id+"\x00") || !strings.HasSuffix(v.Scope, fmt.Sprintf("\x00%d", status)) {
		return 410, terminalOutputGap
	}
	plain, e := s.transient.open(body, v.Scope)
	if e != nil {
		return 410, terminalOutputGap
	}
	return status, plain
}
func (s *RelayStore) AcknowledgeOutput(id string) error {
	var body []byte
	var digest string
	e := s.db.QueryRow(`SELECT digest,result FROM rpc_receipts WHERE id=?`, id).Scan(&digest, &body)
	if e != nil {
		return e
	}
	if strings.HasPrefix(digest, "input-v1:") || digest == "input-expired" {
		return s.expireInput(id)
	}
	if !encryptedTerminalOutput(body) {
		return nil
	}
	_, e = s.db.Exec(`UPDATE rpc_receipts SET status=410,result=? WHERE id=? AND state='completed'`, []byte(terminalOutputGap), id)
	return e
}
func (s *RelayStore) ScrubTransientOutputs() error {
	if e := s.scrubInputReceipts(); e != nil {
		return e
	}
	rows, e := s.db.Query(`SELECT id,status,result FROM rpc_receipts WHERE state='completed' AND CAST(result AS TEXT) LIKE '{"_terminal_transient":%' LIMIT 256`)
	if e != nil {
		return e
	}
	type candidate struct {
		id     string
		status int
		body   []byte
	}
	var values []candidate
	for rows.Next() {
		var c candidate
		if e = rows.Scan(&c.id, &c.status, &c.body); e != nil {
			rows.Close()
			return e
		}
		values = append(values, c)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, c := range values {
		status, _ := s.readTransient(c.id, c.status, c.body)
		if status == 410 {
			if e = s.AcknowledgeOutput(c.id); e != nil {
				return e
			}
		}
	}
	return nil
}

func terminalInputRPC(r RPCRequest) bool {
	u, e := url.Parse(r.Path)
	return e == nil && r.Method == "POST" && strings.HasPrefix(u.Path, "/v1/terminals/") && strings.HasSuffix(u.Path, "/input")
}
func (t *transientCipher) inputDigest(raw []byte, expires string) string {
	h := hmac.New(sha256.New, t.digestKey[:])
	h.Write(raw)
	h.Write([]byte{0})
	h.Write([]byte(expires))
	return "input-v1:" + t.session + ":" + expires + ":" + hex.EncodeToString(h.Sum(nil))
}
func (t *transientCipher) inputReceiptActive(digest string) bool {
	parts := strings.Split(digest, ":")
	if len(parts) != 4 || parts[0] != "input-v1" || parts[1] != t.session {
		return false
	}
	expires, e := strconv.ParseInt(parts[2], 10, 64)
	now := t.now().UnixNano()
	return e == nil && expires > now && expires-now <= int64(terminalOutputTTL)
}
func (s *RelayStore) expireInput(id string) error {
	_, e := s.db.Exec(`UPDATE rpc_receipts SET digest='input-expired',status=410,result=? WHERE id=?`, []byte(terminalInputGap), id)
	return e
}
func (s *RelayStore) scrubInputReceipts() error {
	rows, e := s.db.Query(`SELECT id,digest FROM rpc_receipts WHERE digest LIKE 'input-v1:%' LIMIT 256`)
	if e != nil {
		return e
	}
	type pair struct{ id, digest string }
	var values []pair
	for rows.Next() {
		var p pair
		if e = rows.Scan(&p.id, &p.digest); e != nil {
			rows.Close()
			return e
		}
		values = append(values, p)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, p := range values {
		if !s.transient.inputReceiptActive(p.digest) {
			if e = s.expireInput(p.id); e != nil {
				return e
			}
		}
	}
	return nil
}
