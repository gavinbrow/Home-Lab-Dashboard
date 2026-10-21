package transport

import (
	"context"
	"encoding/json"
	"homelab/agent/internal/files"
	"homelab/agent/internal/supervisor"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalRequiresTokenAndRootedReads(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello"), 0600)
	root, e := files.Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	j, e := supervisor.OpenJournal(filepath.Join(t.TempDir(), "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer j.Close()
	local := Local{Token: strings.Repeat("x", 48), Supervisor: &supervisor.Service{Journal: j, Config: supervisor.Config{Workspaces: []supervisor.Workspace{{ID: "w", Root: dir}}}}, Roots: map[string]*files.Root{"w": root}, Writable: map[string]bool{"w": true}}
	handler := local.Handler()
	r := httptest.NewRequest("GET", "/v1/workspaces/w/files?path=file.txt&mode=read", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, r)
	if rr.Code != 401 {
		t.Fatal(rr.Code)
	}
	r.Header.Set("Authorization", "Bearer "+local.Token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, r)
	if rr.Code != 200 {
		t.Fatal(rr.Code, rr.Body.String())
	}
	var body map[string]any
	if e = json.Unmarshal(rr.Body.Bytes(), &body); e != nil || body["content_base64"] != "aGVsbG8=" {
		t.Fatal(body, e)
	}
	r = httptest.NewRequest("GET", "/v1/workspaces/w/files?path=../secret&mode=read", nil)
	r.Header.Set("Authorization", "Bearer "+local.Token)
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, r)
	if rr.Code == 200 {
		t.Fatal("traversal accepted")
	}
}
func TestAgentRejectsCleartextBeforeSending(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()
	if e := Post(context.Background(), server.Client(), server.URL, map[string]string{}); e == nil {
		t.Fatal("cleartext accepted")
	}
	if called {
		t.Fatal("sent rejected request")
	}
}
func TestLoopbackOnly(t *testing.T) {
	for _, address := range []string{"0.0.0.0:9000", ":9000", "localhost:9000", "192.168.1.2:9000"} {
		if Loopback(address) {
			t.Fatal(address)
		}
	}
	if !Loopback("127.0.0.1:9000") || !Loopback("[::1]:9000") {
		t.Fatal("loopback rejected")
	}
}
