package transport

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

func terminalOutputBody(body []byte) bool {
	var v struct {
		Data   *json.RawMessage `json:"data"`
		Record struct {
			Request struct {
				Command struct {
					Executable string `json:"executable"`
				} `json:"command"`
			} `json:"request"`
		} `json:"record"`
	}
	return json.Unmarshal(body, &v) == nil && v.Data != nil && v.Record.Request.Command.Executable == "__workspace_terminal__"
}
func encodePendingResult(cipher *transientCipher, r RPCRequest, result RPCResult) ([]byte, error) {
	raw, e := json.Marshal(result)
	if e != nil {
		return nil, e
	}
	if (terminalOutputRPC(r) || terminalOutputBody(result.Body)) && result.Status == 200 {
		return cipher.seal(raw, transientScope(r.ID, r.Method, r.Path, result.Status)+"\x00"+result.MachineID)
	}
	return raw, nil
}
func decodePendingResult(cipher *transientCipher, id, machine string, raw []byte) (RPCResult, error) {
	var result RPCResult
	encrypted := encryptedTerminalOutput(raw)
	if encrypted {
		var v transientEnvelope
		if json.Unmarshal(raw, &v) != nil || !strings.HasPrefix(v.Scope, id+"\x00") || !strings.HasSuffix(v.Scope, "\x00"+machine) {
			return RPCResult{}, errors.New("invalid_terminal_spool_scope")
		}
		plain, e := cipher.open(raw, v.Scope)
		if e != nil {
			return RPCResult{SchemaVersion: 1, ID: id, MachineID: machine, Status: 410, Body: terminalOutputGap}, nil
		}
		raw = plain
	}
	if e := json.Unmarshal(raw, &result); e != nil {
		return result, e
	}
	if !encrypted && terminalOutputBody(result.Body) {
		return RPCResult{SchemaVersion: 1, ID: id, MachineID: machine, Status: 410, Body: terminalOutputGap}, nil
	}
	return result, nil
}

// Old versions stored console output directly in the connection spool. Erase
// recognized legacy plaintext before any network attempt, even while offline.
func scrubLegacyPendingOutputs(db *sql.DB) error {
	rows, err := db.Query(`SELECT id,body FROM outbound_results`)
	if err != nil {
		return err
	}
	type replacement struct {
		id   string
		body []byte
	}
	var updates []replacement
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return err
		}
		if encryptedTerminalOutput(raw) {
			continue
		}
		var r RPCResult
		if json.Unmarshal(raw, &r) == nil && terminalOutputBody(r.Body) {
			r.ID = id
			r.Status = 410
			r.Body = terminalOutputGap
			body, e := json.Marshal(r)
			if e != nil {
				rows.Close()
				return e
			}
			updates = append(updates, replacement{id, body})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, u := range updates {
		if _, err = db.Exec(`UPDATE outbound_results SET body=? WHERE id=?`, u.body, u.id); err != nil {
			return err
		}
	}
	return nil
}
func acknowledgeLocalOutput(ctx context.Context, client *http.Client, base, token, id string) error {
	payload, _ := json.Marshal(map[string]string{"id": id})
	request, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(base, "/")+"/v1/rpc-output-acks", bytes.NewReader(payload))
	if e != nil {
		return e
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	response, e := client.Do(request.WithContext(bounded))
	if e != nil {
		return e
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("terminal_cache_ack_failed")
	}
	return nil
}

// A verified server's 410 on this exact durable result means delivery has already
// been consumed or expired. Drain it exactly as an ACK: keep the supervisor's
// nonreplayable ID tombstone, scrub transient output, and poll new work. No local
// command dispatch is performed by this path.
func deliverPendingResult(ctx context.Context, client *http.Client, endpoint string, result RPCResult) error {
	err := JSONRequest(ctx, client, endpoint, result, nil)
	var status *relayStatusError
	if errors.As(err, &status) && status.Status == http.StatusGone {
		return nil
	}
	return err
}

func drainPendingResult(ctx context.Context, db *sql.DB, client, local *http.Client, endpoint, supervisorURL, token string, result RPCResult) error {
	if err := deliverPendingResult(ctx, client, endpoint, result); err != nil {
		return err
	}
	// Local cleanup is best effort; the helper independently scrubs after 30s.
	// Rejected requests may have no local receipt, so an absent ACK target cannot
	// pin all subsequent polling after the server has consumed this result.
	_ = acknowledgeLocalOutput(ctx, local, supervisorURL, token, result.ID)
	_, err := db.Exec(`DELETE FROM outbound_results WHERE id=?`, result.ID)
	return err
}
