package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestProtectedQuarantineAndNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	r, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	if e = r.SetRecoveryDirectory(t.TempDir()); e != nil {
		t.Fatal(e)
	}
	h, e := r.Write("private.bin", []byte{0, 255, 9}, nil)
	if e != nil {
		t.Fatal(e)
	}
	q, e := r.Quarantine("private.bin", h)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.Read("private.bin"); !os.IsNotExist(e) {
		t.Fatal("not quarantined", e)
	}
	s, e := r.Capture()
	if e != nil || len(s.Files) != 0 {
		t.Fatal("recovery bytes entered project", s, e)
	}
	_, _ = r.Write("private.bin", []byte("external"), nil)
	if e = r.RestoreQuarantine(q.ID); e == nil {
		t.Fatal("restored over external edit")
	}
	_ = os.Remove(filepath.Join(dir, "private.bin"))
	if e = r.RestoreQuarantine(q.ID); e != nil {
		t.Fatal(e)
	}
	b, e := r.Read("private.bin")
	if e != nil || Hash(b) != h {
		t.Fatal("byte recovery failed", b, e)
	}
}
func TestQuotaIncludesAllFiles(t *testing.T) {
	r, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	h, e := r.WriteWithQuota("a", []byte("1234"), nil, 6)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.WriteWithQuota("b", []byte("5678"), nil, 6); e == nil {
		t.Fatal("cumulative quota bypass")
	}
	if _, e = r.WriteWithQuota("a", []byte("12"), &h, 6); e != nil {
		t.Fatal(e)
	}
	if _, e = r.WriteWithQuota("b", []byte("5678"), nil, 6); e != nil {
		t.Fatal(e)
	}
}
func TestRestoreCASPrecheckpointAndPartialClassification(t *testing.T) {
	r, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	_, _ = r.Write("a", []byte("before"), nil)
	s, _ := r.Capture()
	h := Hash([]byte("after"))
	q := RestoreRequest{ExpectedManifestHash: "stale", Files: []SnapshotFile{{Entry: Entry{Path: "a", Kind: "file", SHA256: &h, SizeBytes: 5, Mode: 0600}, Bytes: []byte("after")}}}
	called := false
	if e = r.Restore(q, func(Snapshot) error { called = true; return nil }); e == nil || called {
		t.Fatal("CAS must precede checkpoint", e, called)
	}
	q.ExpectedManifestHash = ManifestHash(s)
	if e = r.Restore(q, func(Snapshot) error { return errors.New("checkpoint offline") }); e == nil {
		t.Fatal("checkpoint failure ignored")
	}
	b, _ := r.Read("a")
	if string(b) != "before" {
		t.Fatal("changed without checkpoint")
	}
	if e = r.Restore(q, func(Snapshot) error { called = true; return nil }); e != nil {
		t.Fatal(e)
	}
	b, _ = r.Read("a")
	if string(b) != "after" {
		t.Fatal("not restored")
	}
}
func TestRestorePartialNeverDefinitiveConflict(t *testing.T) {
	r, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	_, _ = r.Write("a", []byte("a"), nil)
	s, _ := r.Capture()
	h := Hash([]byte("new"))
	q := RestoreRequest{ExpectedManifestHash: ManifestHash(s), Files: []SnapshotFile{{Entry: Entry{Path: "a", Kind: "file", SHA256: &h, SizeBytes: 3, Mode: 0600}, Bytes: []byte("new")}, {Entry: Entry{Path: "missing/child", Kind: "file", SHA256: &h, SizeBytes: 3, Mode: 0600}, Bytes: []byte("new")}}}
	e = r.Restore(q, func(Snapshot) error { return nil })
	if e == nil || e.Error() == "file_conflict" {
		t.Fatal("partial mutation misclassified", e)
	}
	b, _ := r.Read("a")
	if string(b) != "new" {
		t.Fatal("fixture did not publish first file")
	}
}

func TestRestoreReviewedKindReplacement(t *testing.T) {
	r, e := Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	if e = r.Mkdir("node"); e != nil {
		t.Fatal(e)
	}
	_, _ = r.Write("node/child", []byte("old"), nil)
	s, _ := r.Capture()
	h := Hash([]byte("new"))
	q := RestoreRequest{ExpectedManifestHash: ManifestHash(s), Files: []SnapshotFile{{Entry: Entry{Path: "node", Kind: "file", Mode: 0600, SHA256: &h, SizeBytes: 3}, Bytes: []byte("new")}}, DeletePaths: []string{"node"}}
	called := false
	if e = r.Restore(q, func(Snapshot) error { called = true; return nil }); e == nil || called {
		t.Fatal("deleted directory with unreviewed descendant", e)
	}
	q.DeletePaths = []string{"node", "node/child"}
	if e = r.Restore(q, func(Snapshot) error { return nil }); e != nil {
		t.Fatal(e)
	}
	b, _ := r.Read("node")
	if string(b) != "new" {
		t.Fatal(b)
	}
	s, _ = r.Capture()
	q = RestoreRequest{ExpectedManifestHash: ManifestHash(s), Files: []SnapshotFile{{Entry: Entry{Path: "node", Kind: "directory", Mode: 0700}}, {Entry: Entry{Path: "node/child", Kind: "file", Mode: 0600, SHA256: &h, SizeBytes: 3}, Bytes: []byte("new")}}, DeletePaths: []string{"node"}}
	if e = r.Restore(q, func(Snapshot) error { return nil }); e != nil {
		t.Fatal(e)
	}
	b, _ = r.Read("node/child")
	if string(b) != "new" {
		t.Fatal(b)
	}
}
