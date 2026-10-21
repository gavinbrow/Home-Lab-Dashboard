package transport

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"time"

	"homelab/agent/internal/protocol"
	"homelab/agent/internal/terminal"
)

func terminalPage(r *http.Request) (int64, int, error) {
	after := int64(0)
	max := 65536
	var e error
	if v := r.URL.Query().Get("after"); v != "" {
		after, e = strconv.ParseInt(v, 10, 64)
		if e != nil {
			return 0, 0, e
		}
	}
	if v := r.URL.Query().Get("max"); v != "" {
		max, e = strconv.Atoi(v)
		if e != nil {
			return 0, 0, e
		}
	}
	if after < 0 || max < 1 || max > 65536 {
		return 0, 0, errors.New("invalid_terminal_page")
	}
	return after, max, nil
}
func (l *Local) registerTerminals(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/terminals", func(w http.ResponseWriter, r *http.Request) {
		var q terminal.Spec
		if e := decode(w, r, &q); e != nil {
			fail(w, e)
			return
		}
		record, e := l.Supervisor.StartTerminal(r.Context(), q)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 202, record)
	})
	mux.HandleFunc("GET /v1/terminals/{id}", func(w http.ResponseWriter, r *http.Request) {
		after, max, e := terminalPage(r)
		if e != nil {
			fail(w, e)
			return
		}
		m, e := l.Supervisor.TerminalAccess(r.PathValue("id"), false)
		if e != nil {
			fail(w, e)
			return
		}
		out, e := m.Read(r.Context(), r.PathValue("id"), after, max)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, out)
	})
	mux.HandleFunc("POST /v1/terminals/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Fence         int64  `json:"fence"`
			DispatchEpoch string `json:"dispatch_epoch"`
		}
		if e := decode(w, r, &q); e != nil {
			fail(w, e)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		record, e := l.Supervisor.CancelTerminal(ctx, r.PathValue("id"), q.Fence, q.DispatchEpoch)
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, record)
	})
	for _, verb := range []string{"attach", "detach", "input", "resize"} {
		mux.HandleFunc("POST /v1/terminals/{id}/"+verb, func(w http.ResponseWriter, r *http.Request) {
			var q struct {
				ClientID string `json:"client_id"`
				After    int64  `json:"after,omitempty"`
				Max      int    `json:"max,omitempty"`
				Data     string `json:"data,omitempty"`
				Cols     uint16 `json:"cols,omitempty"`
				Rows     uint16 `json:"rows,omitempty"`
			}
			if e := decode(w, r, &q); e != nil {
				fail(w, e)
				return
			}
			if !protocol.ValidID(q.ClientID) || len(q.ClientID) > 128 {
				fail(w, errors.New("invalid_terminal_client"))
				return
			}
			id := r.PathValue("id")
			m, e := l.Supervisor.TerminalAccess(id, true)
			if e != nil {
				fail(w, e)
				return
			}
			switch verb {
			case "attach":
				if q.Max == 0 {
					q.Max = 65536
				}
				if q.After < 0 || q.Max < 1 || q.Max > 65536 {
					fail(w, errors.New("invalid_terminal_page"))
					return
				}
				out, err := m.AttachClient(r.Context(), id, q.ClientID, q.After, q.Max)
				if err != nil {
					fail(w, err)
					return
				}
				respond(w, 200, out)
				return
			case "detach":
				e = m.DetachClient(id, q.ClientID)
			case "resize":
				e = m.ResizeClient(id, q.ClientID, q.Cols, q.Rows)
			case "input":
				if len(q.Data) > 87384 {
					fail(w, errors.New("terminal_input_limit"))
					return
				}
				var data []byte
				data, e = base64.StdEncoding.Strict().DecodeString(q.Data)
				if e == nil && len(data) > 65536 {
					e = errors.New("terminal_input_limit")
				}
				if e == nil {
					e = m.InputClient(id, q.ClientID, data)
				}
			}
			if e != nil {
				fail(w, e)
				return
			}
			respond(w, 200, map[string]any{"accepted": true, "id": id})
		})
	}
}
