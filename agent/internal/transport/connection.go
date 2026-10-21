package transport

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"homelab/agent/internal/enrollment"
	"homelab/agent/internal/telemetry"
	_ "modernc.org/sqlite"
)

type ConnectionConfig struct {
	MachineID                string `json:"machine_id"`
	ControlPlaneURL          string `json:"control_plane_url"`
	ServerCAFile             string `json:"server_ca_file"`
	IdentityDir              string `json:"identity_dir"`
	SupervisorURL            string `json:"supervisor_url"`
	LocalTokenFile           string `json:"local_token_file"`
	DataDir                  string `json:"data_dir"`
	TelemetryIntervalSeconds int    `json:"telemetry_interval_seconds"`
	NvidiaSMI                string `json:"nvidia_smi"`
}

func RunConnection(ctx context.Context, c ConnectionConfig) error {
	base, e := url.Parse(c.ControlPlaneURL)
	if e != nil || base.Scheme != "https" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return errors.New("configured_https_control_plane_required")
	}
	localURL, e := url.Parse(c.SupervisorURL)
	if e != nil || localURL.Scheme != "http" || !Loopback(localURL.Host) || localURL.Path != "" || localURL.RawQuery != "" || localURL.User != nil {
		return errors.New("loopback_supervisor_required")
	}
	if !filepath.IsAbs(c.DataDir) {
		return errors.New("absolute_connection_data_dir_required")
	}
	if e = os.MkdirAll(c.DataDir, 0700); e != nil {
		return e
	}
	token, e := os.ReadFile(c.LocalTokenFile)
	if e != nil {
		return e
	}
	secret := strings.TrimSpace(string(token))
	if len(secret) < 32 {
		return errors.New("local_token_too_short")
	}
	id, e := enrollment.Load(c.IdentityDir)
	if e != nil {
		return e
	}
	if id.MachineID != c.MachineID {
		return errors.New("connection_identity_machine_mismatch")
	}
	client, e := MTLSClient(c.ServerCAFile, id.CertificateFile, id.KeyFile)
	if e != nil {
		return e
	}
	db, e := sql.Open("sqlite", filepath.Join(c.DataDir, "connection.db"))
	if e != nil {
		return e
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, e = db.Exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS outbound_results(id TEXT PRIMARY KEY,body BLOB NOT NULL);`); e != nil {
		return e
	}
	if e = scrubLegacyPendingOutputs(db); e != nil {
		return e
	}
	sequence, e := telemetry.OpenSequence(filepath.Join(c.DataDir, "telemetry.db"))
	if e != nil {
		return e
	}
	defer sequence.Close()
	outboxCipher, e := newTransientCipher()
	if e != nil {
		return e
	}
	collector := telemetry.New()
	collector.NvidiaSMI = c.NvidiaSMI
	interval := time.Duration(c.TelemetryIntervalSeconds) * time.Second
	if interval < time.Second {
		interval = 5 * time.Second
	}
	nextSample := time.Time{}
	boot := ""
	endpoint := strings.TrimRight(c.ControlPlaneURL, "/")
	localClient := &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("local_redirect_denied") }}
	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}
		// Persisted results are delivered before more work is polled. A network loss
		// never turns a lost acknowledgement into a second host mutation.
		var pendingID string
		var pending []byte
		e = db.QueryRow(`SELECT id,body FROM outbound_results ORDER BY rowid LIMIT 1`).Scan(&pendingID, &pending)
		if e == nil {
			result, decodeError := decodePendingResult(outboxCipher, pendingID, c.MachineID, pending)
			if decodeError != nil {
				e = decodeError
				return e
			}
			if e = drainPendingResult(ctx, db, client, localClient, endpoint+"/agent/v1/results", c.SupervisorURL, secret, result); e != nil {
				if !pause(ctx, time.Second) {
					return nil
				}
				continue
			}
			continue
		}
		if e != sql.ErrNoRows {
			return e
		}
		if e = connectionBackupBoundary(ctx, c.DataDir); e != nil {
			return e
		}
		if time.Now().After(nextSample) {
			sample := collector.Collect(ctx, c.MachineID)
			boot = sample.BootID
			sample.Sequence, e = sequence.Next()
			if e != nil {
				return e
			}
			if e = Post(ctx, client, endpoint+"/agent/v1/telemetry", sample); e != nil {
				log.Print("telemetry_upload_failed")
			}
			nextSample = time.Now().Add(interval)
		}
		expiry, e := time.Parse(time.RFC3339, id.ExpiresAt)
		if e != nil {
			return errors.New("invalid_identity_expiry")
		}
		if time.Until(expiry) < 24*time.Hour {
			next, e := enrollment.Rotate(ctx, client, endpoint+"/agent/v1/rotate", c.IdentityDir, c.MachineID)
			if e != nil {
				return errors.New("certificate_rotation_failed_reconcile_or_reenroll")
			}
			id = next
			client, e = MTLSClient(c.ServerCAFile, id.CertificateFile, id.KeyFile)
			if e != nil {
				return e
			}
		}
		if id.DispatchKey == nil {
			if !pause(ctx, time.Second) {
				return nil
			}
			continue
		}
		var poll struct {
			Requests   []RPCRequest `json:"requests"`
			ServerTime string       `json:"server_time"`
		}
		e = JSONRequest(ctx, client, endpoint+"/agent/v1/poll", map[string]any{"schema_version": 1, "machine_id": c.MachineID, "boot_id": boot, "max_requests": 1}, &poll)
		if e != nil {
			log.Print("relay_poll_failed")
			if !pause(ctx, time.Second) {
				return nil
			}
			continue
		}
		for _, request := range poll.Requests {
			raw, e := json.Marshal(request)
			if e != nil {
				return e
			}
			req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(c.SupervisorURL, "/")+"/v1/rpc", bytes.NewReader(raw))
			if e != nil {
				return e
			}
			req.Header.Set("Authorization", "Bearer "+secret)
			req.Header.Set("Content-Type", "application/json")
			resp, e := localClient.Do(req)
			if e != nil {
				log.Print("local_supervisor_unavailable")
				continue
			}
			data, e := io.ReadAll(io.LimitReader(resp.Body, 96<<20+1))
			resp.Body.Close()
			if e != nil || len(data) > 96<<20 {
				log.Print("local_supervisor_response_limit")
				continue
			}
			var result RPCResult
			if resp.StatusCode == 200 {
				if e = json.Unmarshal(data, &result); e != nil {
					return errors.New("invalid_signed_rpc_response")
				}
			} else {
				result = RPCResult{SchemaVersion: 1, MachineID: c.MachineID, ID: request.ID, Status: resp.StatusCode, Body: data}
				if !json.Valid(data) {
					result.Body = json.RawMessage(`{"error":{"code":"invalid_supervisor_error","message":"Supervisor rejected RPC"}}`)
				}
			}
			if result.ID != request.ID || result.MachineID != c.MachineID {
				return errors.New("local_supervisor_result_identity_mismatch")
			}
			payload, e := encodePendingResult(outboxCipher, request, result)
			if e != nil {
				return e
			}
			if _, e = db.Exec(`INSERT OR IGNORE INTO outbound_results(id,body)VALUES(?,?)`, result.ID, payload); e != nil {
				return e
			}
		}
		if len(poll.Requests) == 0 && !pause(ctx, 500*time.Millisecond) {
			return nil
		}
	}
}
func pause(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
