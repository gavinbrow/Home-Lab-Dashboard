package hostops

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"homelab/agent/internal/files"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResumableUploadsPublicationAndBoundedStaging(t *testing.T) {
	m, root := testManager(t)
	binding, _ := m.binding("ws")
	binding.QuotaBytes = 8 << 20
	m.bindings.Store("ws", binding)
	m.config.MaxStagedBytes = 3 << 20
	mux := http.NewServeMux()
	m.Register(mux)
	rpc := func(method, path string, body any, want int) []byte {
		t.Helper()
		data, _ := json.Marshal(body)
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest(method, path, bytes.NewReader(data)))
		if out.Code != want {
			t.Fatalf("%s %s => %d expected%d: %s", method, path, out.Code, want, out.Body.String())
		}
		return out.Body.Bytes()
	}
	data := bytes.Repeat([]byte("a"), UploadChunkBytes+7)
	hash := files.Hash(data)
	base := "/v1/workspaces/ws/uploads"
	create := func(id string, expected *string) {
		rpc("POST", base, map[string]any{"upload_id": id, "path": "big.bin", "total_bytes": len(data), "sha256": hash, "expected_sha256": expected}, 200)
	}
	chunk := func(id string, offset int64, part []byte, want int) {
		rpc("PUT", base+"/"+id+"/chunks", map[string]any{"offset": offset, "content_base64": base64.StdEncoding.EncodeToString(part), "sha256": files.Hash(part)}, want)
	}
	complete := func(id, op string) Receipt {
		out := rpc("POST", base+"/"+id+"/complete", map[string]any{"operation_id": op}, 200)
		var r Receipt
		_ = json.Unmarshal(out, &r)
		return r
	}
	create("upload1", nil)
	if r := complete("upload1", "premature"); r.State != "failed" || r.EffectsStarted == nil || *r.EffectsStarted {
		t.Fatal("premature upload reserved writer", r)
	}
	chunk("upload1", 0, []byte("a"), 409)
	chunk("upload1", 1, data[:UploadChunkBytes], 409)
	chunk("upload1", UploadChunkBytes, data[UploadChunkBytes:], 200)
	chunk("upload1", 0, data[:UploadChunkBytes], 200)
	chunk("upload1", 0, data[:UploadChunkBytes], 200)
	if _, e := root.Read("big.bin"); !os.IsNotExist(e) {
		t.Fatal("partial destination published", e)
	}
	r := complete("upload1", "publish1")
	if r.State != "completed" {
		t.Fatal(r)
	}
	got, e := root.Read("big.bin")
	if e != nil || !bytes.Equal(got, data) {
		t.Fatal("published bytes differ", e)
	}
	if _, e = os.Stat(filepath.Join(m.config.DataDir, "uploads", "ws", "upload1", "content")); !os.IsNotExist(e) {
		t.Fatal("completed bytes retained unbounded", e)
	}
	u, e := m.loadUpload("ws", "upload1")
	if e != nil || u.State != "completed" || u.ReceivedBytes != int64(len(data)) || len(u.Ranges) != 0 {
		t.Fatal("completion metadata unbounded", u, e)
	}
	for _, id := range []string{"upload2", "upload3"} {
		create(id, &hash)
		chunk(id, 0, data[:UploadChunkBytes], 200)
		chunk(id, UploadChunkBytes, data[UploadChunkBytes:], 200)
		if r = complete(id, "publish-"+id); r.State != "completed" {
			t.Fatal(r)
		}
	}
	var retained int64
	_ = m.db.QueryRow(`SELECT COALESCE(SUM(total_bytes),0) FROM hostops_uploads WHERE state IN ('uploading','published','cancelling')`).Scan(&retained)
	if retained != 0 {
		t.Fatal("staging budget leaked", retained)
	}
	rpc("DELETE", base+"/upload1", nil, 409)
	create("stale", &hash)
	chunk("stale", 0, data[:UploadChunkBytes], 200)
	chunk("stale", UploadChunkBytes, data[UploadChunkBytes:], 200)
	binding.Revision++
	m.bindings.Store("ws", binding)
	if r = complete("stale", "stale-publish"); r.State != "failed" || r.EffectsStarted == nil || *r.EffectsStarted {
		t.Fatal("stale binding publication", r)
	}
	rpc("DELETE", base+"/stale", nil, 200)
	if _, e = os.Stat(filepath.Join(m.config.DataDir, "uploads", "ws", "stale", "content")); !os.IsNotExist(e) {
		t.Fatal("cancel did not clean protected stage", e)
	}
}

func TestUploadExpirationNeverDeletesUnknownRecoveryStage(t *testing.T) {
	m, _ := testManager(t)
	b, _ := m.binding("ws")
	b.QuotaBytes = 4 << 20
	m.bindings.Store("ws", b)
	mux := http.NewServeMux()
	m.Register(mux)
	create := func(id string) {
		body, _ := json.Marshal(map[string]any{"upload_id": id, "path": id, "total_bytes": 0, "sha256": files.Hash(nil), "expected_sha256": nil})
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest("POST", "/v1/workspaces/ws/uploads", bytes.NewReader(body)))
		if out.Code != 200 {
			t.Fatal(out.Code, out.Body.String())
		}
	}
	create("expired")
	old := time.Now().Add(-25 * time.Hour).UTC().Format(time.RFC3339Nano)
	_, _ = m.db.Exec(`UPDATE hostops_uploads SET updated_at=? WHERE upload_id='expired'`, old)
	m.mu.Lock()
	m.pruneUploadsLocked(time.Now())
	m.mu.Unlock()
	u, e := m.loadUpload("ws", "expired")
	if e != nil || u.State != "expired" {
		t.Fatal(u, e)
	}
	if _, e = os.Stat(filepath.Join(m.config.DataDir, "uploads", "ws", "expired", "content")); !os.IsNotExist(e) {
		t.Fatal("expired stage retained", e)
	}
	create("recovery")
	_ = m.mutate("unknown-publication", "/v1/workspaces/ws/uploads/recovery/complete", nil, func() (any, error) { return nil, errors.New("unknown publication") })
	_, _ = m.db.Exec(`UPDATE hostops_uploads SET updated_at=? WHERE upload_id='recovery'`, old)
	m.mu.Lock()
	m.pruneUploadsLocked(time.Now())
	m.mu.Unlock()
	u, e = m.loadUpload("ws", "recovery")
	if e != nil || u.State != "uploading" {
		t.Fatal("unknown recovery bytes expired", u, e)
	}
	if _, e = os.Stat(filepath.Join(m.config.DataDir, "uploads", "ws", "recovery", "content")); e != nil {
		t.Fatal("unknown stage deleted", e)
	}
}
