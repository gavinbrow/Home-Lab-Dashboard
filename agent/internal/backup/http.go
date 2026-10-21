package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
)

func answer(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
func deny(w http.ResponseWriter, code string, status int) {
	answer(w, status, map[string]any{"error": map[string]string{"code": code, "message": code}})
}
func decode(r *http.Request, v any) error {
	defer r.Body.Close()
	d := json.NewDecoder(io.LimitReader(r.Body, 8193))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return errors.New("invalid_json")
	}
	return nil
}
func (m *Manager) createHTTP(w http.ResponseWriter, r *http.Request) {
	var q Request
	if e := decode(r, &q); e != nil {
		deny(w, "invalid_capture_request", 400)
		return
	}
	capture, e := m.Start(q)
	if e != nil {
		deny(w, e.Error(), 409)
		return
	}
	answer(w, 202, capture)
}
func (m *Manager) statusHTTP(w http.ResponseWriter, r *http.Request) {
	capture, e := m.Get(r.PathValue("id"))
	if e != nil {
		deny(w, "capture_not_found", 404)
		return
	}
	answer(w, 200, capture)
}
func (m *Manager) chunkHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, e := m.Get(r.PathValue("id"))
	if e != nil || c.State != "ready" {
		deny(w, "capture_not_ready", 409)
		return
	}
	index, e := strconv.ParseInt(r.PathValue("index"), 10, 64)
	if e != nil || index < 0 || index >= c.ChunkCount {
		deny(w, "invalid_chunk_index", 400)
		return
	}
	f, e := os.Open(filepath.Join(m.cfg.StagingDir, c.ID+".age"))
	if e != nil {
		deny(w, "capture_bytes_unavailable", 409)
		return
	}
	defer f.Close()
	offset := index * c.ChunkSizeBytes
	size := min(c.ChunkSizeBytes, c.SizeBytes-offset)
	b := make([]byte, int(size))
	if _, e = f.ReadAt(b, offset); e != nil {
		deny(w, "capture_chunk_unavailable", 409)
		return
	}
	hash := sha256.Sum256(b)
	answer(w, 200, map[string]any{"id": c.ID, "index": index, "offset": offset, "size_bytes": size, "sha256": hex.EncodeToString(hash[:]), "content_base64": b})
}
func (m *Manager) ackHTTP(w http.ResponseWriter, r *http.Request) {
	var q struct {
		SHA256 string `json:"sha256"`
	}
	if e := decode(r, &q); e != nil {
		deny(w, "invalid_capture_ack", 400)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	c, e := m.Get(r.PathValue("id"))
	if e != nil || (c.State != "ready" && c.State != "acknowledged") || q.SHA256 != c.SHA256 {
		deny(w, "capture_ack_hash_conflict", 409)
		return
	}
	c.Acknowledged = true
	c.State = "acknowledged"
	if e = m.save(c); e != nil {
		deny(w, "capture_ack_storage_failed", 503)
		return
	}
	if e = os.Remove(filepath.Join(m.cfg.StagingDir, c.ID+".age")); e != nil && !errors.Is(e, os.ErrNotExist) {
		deny(w, "acknowledged_capture_cleanup_failed", 503)
		return
	}
	answer(w, 200, c)
}
func (m *Manager) cancelHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, e := m.Get(r.PathValue("id"))
	if e != nil {
		deny(w, "capture_not_found", 404)
		return
	}
	if cancel := m.cancels[c.ID]; cancel != nil {
		cancel()
		answer(w, 202, map[string]any{"id": c.ID, "state": "cancelling"})
		return
	}
	if e = os.Remove(filepath.Join(m.cfg.StagingDir, c.ID+".age")); e != nil && !errors.Is(e, os.ErrNotExist) {
		deny(w, "capture_cleanup_failed", 503)
		return
	}
	c.State = "deleted"
	if e = m.save(c); e != nil {
		deny(w, "capture_delete_storage_failed", 503)
		return
	}
	answer(w, 200, c)
}
