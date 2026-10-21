package transport

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"homelab/agent/internal/files"
	"homelab/agent/internal/protocol"
	"homelab/agent/internal/supervisor"
)

type Local struct {
	Supervisor         *supervisor.Service
	Token              string
	Roots              map[string]*files.Root
	Writable           map[string]bool
	Verifier           *RPCVerifier
	Relay              *RelayStore
	RequireSignedRPC   bool
	RegisterExtra      func(*http.ServeMux)
	ExternalFileWrites bool
}

func Loopback(address string) bool {
	host, _, e := net.SplitHostPort(address)
	if e != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, e error) {
	code := http.StatusBadRequest
	if errors.Is(e, sql.ErrNoRows) {
		code = http.StatusNotFound
	}
	if e == supervisor.ErrConflict || e == supervisor.ErrFence || e.Error() == "file_conflict" {
		code = http.StatusConflict
	}
	respond(w, code, map[string]any{"error": map[string]string{"code": e.Error(), "message": e.Error()}})
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	limit := int64(24 << 20)
	if r.URL.Path == "/v1/rpc" {
		limit = 96 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return errors.New("invalid_json")
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return errors.New("invalid_json_trailing_data")
	}
	return nil
}
func (l *Local) Handler() http.Handler {
	mux := http.NewServeMux()
	l.registerTerminals(mux)
	mux.HandleFunc("POST /v1/rpc-output-acks", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			ID string `json:"id"`
		}
		if e := decode(w, r, &q); e != nil {
			fail(w, e)
			return
		}
		if l.Relay == nil || !protocol.ValidID(q.ID) {
			fail(w, errors.New("invalid_rpc_output_ack"))
			return
		}
		if e := l.Relay.AcknowledgeOutput(q.ID); e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, map[string]bool{"accepted": true})
	})
	mux.HandleFunc("GET /v1/rpc-receipts/{id}", func(w http.ResponseWriter, r *http.Request) {
		if l.Relay == nil {
			fail(w, errors.New("relay_journal_unconfigured"))
			return
		}
		result, e := l.Relay.Inspect(r.PathValue("id"))
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, result)
	})
	if l.RegisterExtra != nil {
		l.RegisterExtra(mux)
	}
	mux.HandleFunc("POST /v1/rpc", func(w http.ResponseWriter, r *http.Request) {
		if l.Verifier == nil || l.Relay == nil {
			fail(w, errors.New("signed_relay_unconfigured"))
			return
		}
		var request RPCRequest
		if e := decode(w, r, &request); e != nil {
			fail(w, e)
			return
		}
		if e := l.Verifier.Verify(request); e != nil {
			fail(w, e)
			return
		}
		result, e := l.Relay.Execute(r.Context(), request, l.Supervisor.Config.MachineID, mux, l.Token)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, result)
	})
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, r *http.Request) {
		identities := l.Supervisor.Identities()
		configured := len(identities) > 0
		verified := false
		for _, id := range identities {
			if id["restriction_verified"] == true {
				verified = true
			}
		}
		state := "disabled"
		verification := "not_run"
		if configured {
			state = "configured"
		}
		if verified {
			state = "enabled"
			verification = "verified"
		}
		respond(w, 200, map[string]any{"schema_version": 1, "machine_id": l.Supervisor.Config.MachineID, "native_execution": state, "runner": map[string]any{"configured": configured, "supported": configured, "verification": verification}})
	})
	mux.HandleFunc("GET /v1/identities", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"items": l.Supervisor.Identities()})
	})
	mux.HandleFunc("GET /v1/roots", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"items": l.Supervisor.Roots()})
	})
	mux.HandleFunc("POST /v1/identities/{id}/verify", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		proof, e := l.Supervisor.VerifyIdentity(ctx, r.PathValue("id"))
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, proof)
	})
	mux.HandleFunc("POST /v1/operations", func(w http.ResponseWriter, r *http.Request) {
		var req protocol.Request
		if e := decode(w, r, &req); e != nil {
			fail(w, e)
			return
		}
		receipt, e := l.Supervisor.Dispatch(req)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 202, receipt)
	})
	mux.HandleFunc("GET /v1/operations/{id}", func(w http.ResponseWriter, r *http.Request) {
		rec, e := l.Supervisor.Journal.Get(r.PathValue("id"))
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, rec.Receipt)
	})
	mux.HandleFunc("POST /v1/operations/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		var c struct {
			Fence         int64  `json:"fence"`
			DispatchEpoch string `json:"dispatch_epoch"`
		}
		if e := decode(w, r, &c); e != nil {
			fail(w, e)
			return
		}
		receipt, e := l.Supervisor.Cancel(r.PathValue("id"), c.Fence, c.DispatchEpoch)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 202, receipt)
	})
	mux.HandleFunc("GET /v1/operations/{id}/logs", func(w http.ResponseWriter, r *http.Request) {
		after := int64(0)
		if s := r.URL.Query().Get("after"); s != "" {
			var e error
			after, e = strconv.ParseInt(s, 10, 64)
			if e != nil || after < 0 {
				fail(w, errors.New("invalid_cursor"))
				return
			}
		}
		logs, e := l.Supervisor.Journal.Logs(r.PathValue("id"), after)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, map[string]any{"logs": logs})
	})
	mux.HandleFunc("GET /v1/workspaces/{id}/manifest", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if e := l.Supervisor.WorkspaceReadable(id); e != nil {
			fail(w, e)
			return
		}
		root := l.Roots[id]
		if root == nil {
			fail(w, errors.New("workspace_not_enrolled"))
			return
		}
		quota := int64(64 << 30)
		for _, v := range l.Supervisor.Config.Workspaces {
			if v.ID == id && v.QuotaBytes > 0 {
				quota = v.QuotaBytes
			}
		}
		manifest, e := root.Manifest(r.Context(), quota)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, manifest)
	})
	mux.HandleFunc("GET /v1/workspaces/{id}/files", func(w http.ResponseWriter, r *http.Request) {
		if e := l.Supervisor.WorkspaceReadable(r.PathValue("id")); e != nil {
			fail(w, e)
			return
		}
		root, ok := l.Roots[r.PathValue("id")]
		if !ok {
			fail(w, errors.New("workspace_not_enrolled"))
			return
		}
		p := r.URL.Query().Get("path")
		if p == "" {
			p = "."
		}
		mode := r.URL.Query().Get("mode")
		if mode == "read_range" {
			offset, e := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
			if e != nil {
				fail(w, errors.New("invalid_offset"))
				return
			}
			length, e := strconv.ParseInt(r.URL.Query().Get("length"), 10, 64)
			if e != nil {
				fail(w, errors.New("invalid_length"))
				return
			}
			b, e := root.ReadRange(p, offset, length)
			if e != nil {
				fail(w, e)
				return
			}
			respond(w, 200, b)
			return
		}
		if mode == "page" || mode == "search" {
			limit := 100
			if raw := r.URL.Query().Get("limit"); raw != "" {
				n, e := strconv.Atoi(raw)
				if e != nil {
					fail(w, errors.New("invalid_limit"))
					return
				}
				limit = n
			}
			if mode == "page" {
				hidden := false
				if raw := r.URL.Query().Get("include_hidden"); raw != "" {
					v, e := strconv.ParseBool(raw)
					if e != nil {
						fail(w, errors.New("invalid_hidden_filter"))
						return
					}
					hidden = v
				}
				page, e := root.ListPage(p, r.URL.Query().Get("cursor"), limit, hidden)
				if e != nil {
					fail(w, e)
					return
				}
				respond(w, 200, page)
				return
			}
			page, e := root.Search(p, r.URL.Query().Get("q"), limit)
			if e != nil {
				fail(w, e)
				return
			}
			respond(w, 200, page)
			return
		}
		if r.URL.Query().Get("mode") == "read" {
			b, e := root.Read(p)
			if e != nil {
				fail(w, e)
				return
			}
			respond(w, 200, map[string]any{"content_base64": b, "sha256": files.Hash(b), "size_bytes": len(b)})
			return
		}
		entries, e := root.List(p)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, entries)
	})
	if !l.ExternalFileWrites {
		mux.HandleFunc("PUT /v1/workspaces/{id}/files", func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("id")
			root, ok := l.Roots[id]
			if !ok || !l.Writable[id] {
				fail(w, errors.New("workspace_write_denied"))
				return
			}
			var req struct {
				Path         string  `json:"path"`
				Content      []byte  `json:"content_base64"`
				ExpectedHash *string `json:"expected_sha256"`
			}
			if e := decode(w, r, &req); e != nil {
				fail(w, e)
				return
			}
			var hash string
			e := l.Supervisor.WithWorkspaceWrite(id, func() error {
				var writeErr error
				hash, writeErr = root.Write(req.Path, req.Content, req.ExpectedHash)
				return writeErr
			})
			if e != nil {
				fail(w, e)
				return
			}
			respond(w, 200, map[string]any{"sha256": hash, "size_bytes": len(req.Content), "external_writer_conflicts": "best_effort_detection"})
		})
	}
	mux.HandleFunc("GET /v1/workspaces/{id}/snapshot", func(w http.ResponseWriter, r *http.Request) {
		if e := l.Supervisor.WorkspaceReadable(r.PathValue("id")); e != nil {
			fail(w, e)
			return
		}
		root, ok := l.Roots[r.PathValue("id")]
		if !ok {
			fail(w, errors.New("workspace_not_enrolled"))
			return
		}
		snap, e := root.Capture()
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, snap)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(l.Token) < 32 || subtle.ConstantTimeCompare([]byte(provided), []byte(l.Token)) != 1 {
			respond(w, 401, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "local supervisor authentication required"}})
			return
		}
		if l.RequireSignedRPC && r.URL.Path != "/v1/rpc" && r.URL.Path != "/v1/health" && !(r.URL.Path == "/v1/rpc-output-acks" && r.Method == "POST") {
			respond(w, 403, map[string]any{"error": map[string]string{"code": "signed_rpc_required", "message": "Host requires a signed dispatch envelope"}})
			return
		}
		mux.ServeHTTP(w, r)
	})
}
