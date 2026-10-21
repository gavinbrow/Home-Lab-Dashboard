package hostops

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"homelab/agent/internal/files"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLargeRestoreStreamsRetainsBeforeBytesAndCleansStaging(t *testing.T) {
	m, root := testManager(t)
	binding, _ := m.binding("ws")
	binding.QuotaBytes = 64 << 20
	m.bindings.Store("ws", binding)
	m.config.MaxCheckpointBytes = 64 << 20
	beforeBytes := bytes.Repeat([]byte("b"), files.MaxFileBytes+19)
	afterBytes := bytes.Repeat([]byte("a"), len(beforeBytes))
	oldHash, newHash := files.Hash(beforeBytes), files.Hash(afterBytes)
	if _, e := root.PublishStream(context.Background(), "large.bin", bytes.NewReader(beforeBytes), int64(len(beforeBytes)), oldHash, nil, binding.QuotaBytes); e != nil {
		t.Fatal(e)
	}
	manifest, e := root.Manifest(context.Background(), binding.QuotaBytes)
	if e != nil {
		t.Fatal(e)
	}
	mode := manifest.Manifest[0].Mode
	mux := http.NewServeMux()
	m.Register(mux)
	rpc := func(method, path string, body any) []byte {
		t.Helper()
		data, _ := json.Marshal(body)
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest(method, path, bytes.NewReader(data)))
		if out.Code != 200 {
			t.Fatalf("%s %s %d %s", method, path, out.Code, out.Body.String())
		}
		return out.Body.Bytes()
	}
	base := "/v1/workspaces/ws/uploads"
	rpc("POST", base, map[string]any{"upload_id": "restore-stage", "path": "large.bin", "total_bytes": len(afterBytes), "sha256": newHash, "expected_sha256": oldHash})
	for offset := 0; offset < len(afterBytes); offset += UploadChunkBytes {
		part := afterBytes[offset:min(offset+UploadChunkBytes, len(afterBytes))]
		rpc("PUT", base+"/restore-stage/chunks", map[string]any{"offset": offset, "content_base64": base64.StdEncoding.EncodeToString(part), "sha256": files.Hash(part)})
	}
	request := files.StreamRestoreRequest{OperationID: "restore-large", ExpectedManifestHash: manifest.Hash(), Files: []files.StreamRestoreFile{{Entry: files.Entry{Path: "large.bin", Kind: "file", Mode: mode, SHA256: &newHash, SizeBytes: int64(len(afterBytes))}, UploadID: "restore-stage"}}, DeletePaths: []string{}}
	var receipt Receipt
	if e = json.Unmarshal(rpc("POST", "/v1/workspaces/ws/restore-stream", request), &receipt); e != nil {
		t.Fatal(e)
	}
	if receipt.State != "completed" {
		t.Fatal(receipt)
	}
	after, e := root.Manifest(context.Background(), binding.QuotaBytes)
	if e != nil || after.Manifest[0].SHA256 == nil || *after.Manifest[0].SHA256 != newHash {
		t.Fatal("large restore failed", after, e)
	}
	checkpoint := filepath.Join(m.config.DataDir, "precheckpoints", "ws-restore-large")
	retained, e := os.ReadFile(filepath.Join(checkpoint, "data", "00000000"))
	if e != nil || files.Hash(retained) != oldHash {
		t.Fatal("pre-restore binary checkpoint missing", e)
	}
	if _, e = os.Stat(filepath.Join(checkpoint, "manifest.json")); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(m.config.DataDir, "uploads", "ws", "restore-stage", "content")); !os.IsNotExist(e) {
		t.Fatal("known completed stage retained", e)
	}
	beforeRepeat := after.Hash()
	var repeated Receipt
	_ = json.Unmarshal(rpc("POST", "/v1/workspaces/ws/restore-stream", request), &repeated)
	if repeated.State != "completed" {
		t.Fatal(repeated)
	}
	afterRepeat, _ := root.Manifest(context.Background(), binding.QuotaBytes)
	if afterRepeat.Hash() != beforeRepeat {
		t.Fatal("replayed restore changed files")
	}
}

func TestRestoreBatchStagesMoreThanThirtyTwoFiles(t *testing.T) {
	m, root := testManager(t)
	_, _ = root.Write("mode-probe", nil, nil)
	before, e := root.Manifest(context.Background(), 1<<20)
	if e != nil {
		t.Fatal(e)
	}
	mode := before.Manifest[0].Mode
	emptyHash := files.Hash(nil)
	mux := http.NewServeMux()
	m.Register(mux)
	entries := make([]files.StreamRestoreFile, 0, 40)
	for i := 0; i < 40; i++ {
		name := fmt.Sprintf("file-%02d", i)
		upload := fmt.Sprintf("batch-%02d", i)
		body, _ := json.Marshal(map[string]any{"upload_id": upload, "path": name, "total_bytes": 0, "sha256": emptyHash, "expected_sha256": nil})
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, httptest.NewRequest("POST", "/v1/workspaces/ws/uploads", bytes.NewReader(body)))
		if out.Code != 200 {
			t.Fatalf("stage%d blocked at former32cap: %d %s", i, out.Code, out.Body.String())
		}
		entries = append(entries, files.StreamRestoreFile{Entry: files.Entry{Path: name, Kind: "file", Mode: mode, SHA256: &emptyHash}, UploadID: upload})
	}
	request := files.StreamRestoreRequest{OperationID: "restore-forty", ExpectedManifestHash: before.Hash(), Files: entries}
	body, _ := json.Marshal(request)
	out := httptest.NewRecorder()
	mux.ServeHTTP(out, httptest.NewRequest("POST", "/v1/workspaces/ws/restore-stream", bytes.NewReader(body)))
	if out.Code != 200 {
		t.Fatal(out.Code, out.Body.String())
	}
	var receipt Receipt
	_ = json.Unmarshal(out.Body.Bytes(), &receipt)
	if receipt.State != "completed" {
		t.Fatal(receipt)
	}
	after, e := root.Manifest(context.Background(), 1<<20)
	if e != nil || len(after.Manifest) != 41 {
		t.Fatal("batch files missing", len(after.Manifest), e)
	}
}
