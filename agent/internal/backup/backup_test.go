package backup

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"filippo.io/age"
	_ "modernc.org/sqlite"
)

func fixture(t *testing.T, size int64) (*Manager, string, string) {
	t.Helper()
	base := t.TempDir()
	project := filepath.Join(base, "project")
	if e := os.Mkdir(project, 0700); e != nil {
		t.Fatal(e)
	}
	f, e := os.Create(filepath.Join(project, "binary.dat"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = io.CopyN(f, zeroReader{}, size); e != nil {
		t.Fatal(e)
	}
	f.Close()
	if e = os.WriteFile(filepath.Join(project, "identity.pem"), []byte("SECRET_PRIVATE_IDENTITY_CANARY"), 0600); e != nil {
		t.Fatal(e)
	}
	db, e := sql.Open("sqlite", filepath.Join(base, "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	db.SetMaxOpenConns(1)
	if _, e = db.Exec("PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000"); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	id, e := age.GenerateX25519Identity()
	if e != nil {
		t.Fatal(e)
	}
	identity := filepath.Join(base, "age.key")
	os.WriteFile(identity, []byte(id.String()), 0600)
	cfg := Config{Enabled: true, Recipient: id.Recipient().String(), GrantIDs: []string{"grant"}, PolicyRevision: 1, StagingDir: filepath.Join(base, "stage"), MachineID: "machine", BootID: "boot", ChunkBytes: 1 << 20, MaxBundleBytes: 64 << 20, Guard: func(fn func() error) error { return fn() }, Roots: []Root{{ID: "workspace-123", Path: project, Kind: "directory", Role: "project", Required: true, Quiesced: true}}}
	m, e := New(db, cfg)
	if e != nil {
		t.Fatal(e)
	}
	return m, base, identity
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = byte(i % 251)
	}
	return len(p), nil
}
func waitCapture(t *testing.T, m *Manager, id string) Capture {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		c, e := m.Get(id)
		if e != nil {
			t.Fatal(e)
		}
		if c.State != "preparing" {
			if c.State != "ready" {
				t.Fatalf("capture failed: %+v", c)
			}
			return c
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("capture timeout")
	return Capture{}
}
func TestEncryptedLargeChunkRoundtrip(t *testing.T) {
	m, base, key := fixture(t, 34<<20)
	q := Request{OperationID: "capture1", BackupSetID: "set", GrantID: "grant", PolicyRevision: 1}
	if _, e := m.Start(q); e != nil {
		t.Fatal(e)
	}
	c := waitCapture(t, m, q.OperationID)
	if c.SizeBytes <= 32<<20 || c.ChunkCount < 33 {
		t.Fatal("large bundle not chunked")
	}
	if !c.Coverage.Complete {
		t.Fatalf("unexpected incomplete %+v", c.Coverage)
	}
	if _, e := m.Start(q); e != nil {
		t.Fatal(e)
	}
	q.BackupSetID = "conflict"
	if _, e := m.Start(q); e == nil {
		t.Fatal("reused id accepted")
	}
	var ciphertext bytes.Buffer
	for i := int64(0); i < c.ChunkCount; i++ {
		r := httptest.NewRequest("GET", "/", nil)
		r.SetPathValue("id", c.ID)
		r.SetPathValue("index", strconv.FormatInt(i, 10))
		w := httptest.NewRecorder()
		m.chunkHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var chunk struct {
			Content []byte `json:"content_base64"`
			SHA256  string `json:"sha256"`
			Offset  int64  `json:"offset"`
		}
		if e := json.Unmarshal(w.Body.Bytes(), &chunk); e != nil {
			t.Fatal(e)
		}
		h := sha256.Sum256(chunk.Content)
		if hex.EncodeToString(h[:]) != chunk.SHA256 || chunk.Offset != int64(ciphertext.Len()) {
			t.Fatal("chunk hash or offset")
		}
		ciphertext.Write(chunk.Content)
	}
	h := sha256.Sum256(ciphertext.Bytes())
	if hex.EncodeToString(h[:]) != c.SHA256 || bytes.Contains(ciphertext.Bytes(), []byte("SECRET_PRIVATE_IDENTITY_CANARY")) {
		t.Fatal("cipher integrity or plaintext leak")
	}
	bundle := filepath.Join(base, "copy.age")
	os.WriteFile(bundle, ciphertext.Bytes(), 0600)
	dest := filepath.Join(base, "unsealed")
	result, e := Unseal(context.Background(), bundle, key, dest, c.SHA256, RestoreLimits{MaxBytes: 64 << 20})
	if e != nil {
		t.Fatal(e)
	}
	if !result.Verified {
		t.Fatal("not verified")
	}
	b, e := os.ReadFile(filepath.Join(dest, "roots", "workspace-123", "identity.pem"))
	if e != nil || string(b) != "SECRET_PRIVATE_IDENTITY_CANARY" {
		t.Fatal("secret restore failed")
	}
	var manifest map[string]any
	b, e = os.ReadFile(filepath.Join(dest, "manifest.json"))
	if e != nil || json.Unmarshal(b, &manifest) != nil || manifest["roots"] == nil || manifest["coverage"] == nil {
		t.Fatal("restore lost root mapping")
	}
	if _, e = Unseal(context.Background(), bundle, key, filepath.Join(base, "too-small"), c.SHA256, RestoreLimits{MaxBytes: 10}); e == nil {
		t.Fatal("restore bomb cap ignored")
	}
	ciphertext.Bytes()[ciphertext.Len()-1] ^= 1
	os.WriteFile(bundle, ciphertext.Bytes(), 0600)
	if _, e = Unseal(context.Background(), bundle, key, filepath.Join(base, "tampered"), c.SHA256, RestoreLimits{}); e == nil {
		t.Fatal("tamper accepted")
	}
}
func TestQuotaPolicyAndOverlap(t *testing.T) {
	m, _, _ := fixture(t, 1)
	m.cfg.MaxRetainedCaptures = 1
	os.WriteFile(filepath.Join(m.cfg.StagingDir, "retained.age"), []byte("x"), 0600)
	if _, e := m.Start(Request{OperationID: "q", BackupSetID: "b", GrantID: "grant", PolicyRevision: 1}); e == nil {
		t.Fatal("retention cap ignored")
	}
	if validateRoots(m.cfg.Roots, filepath.Join(m.cfg.Roots[0].Path, "stage")) == nil {
		t.Fatal("project staging accepted")
	}
	roots := append(m.cfg.Roots, Root{ID: "state", Path: filepath.Join(m.cfg.Roots[0].Path, "state"), Role: "supervisor_state"})
	if validateRoots(roots, m.cfg.StagingDir) == nil {
		t.Fatal("mutable protected role accepted")
	}
}
func makeDB(t *testing.T, p, value string) {
	t.Helper()
	db, e := sql.Open("sqlite", p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = db.Exec("CREATE TABLE canary(value TEXT);INSERT INTO canary VALUES(?)", value); e != nil {
		t.Fatal(e)
	}
	db.Close()
}
func TestRootedSQLiteSwapNeverReadsOutside(t *testing.T) {
	m, base, _ := fixture(t, 1)
	inside := filepath.Join(m.cfg.Roots[0].Path, "project.db")
	outside := filepath.Join(base, "outside.db")
	makeDB(t, inside, "INSIDE_APPROVED")
	makeDB(t, outside, "OUTSIDE_SECRET_CANARY")
	root, e := os.OpenRoot(m.cfg.Roots[0].Path)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	source, e := openRegular(root, "project.db")
	if e != nil {
		t.Fatal(e)
	}
	defer source.Close()
	if e = os.Rename(inside, inside+".old"); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(outside, inside); e != nil {
		b, e := os.ReadFile(outside)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(inside, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	work := filepath.Join(m.cfg.StagingDir, "test-plain")
	os.Mkdir(work, 0700)
	w := captureWriter{ctx: context.Background(), manager: m, snapshots: work}
	clone, _, e := w.cloneProjectSQLite(root, "project.db", source)
	if e != nil {
		t.Fatal(e)
	}
	db, e := sql.Open("sqlite", clone)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var value string
	if e = db.QueryRow("SELECT value FROM canary").Scan(&value); e != nil || value != "INSIDE_APPROVED" {
		t.Fatalf("outside inode reopened: %q %v", value, e)
	}
}
func TestProjectSQLiteWALSnapshot(t *testing.T) {
	m, base, key := fixture(t, 1)
	p := filepath.Join(m.cfg.Roots[0].Path, "wal.db")
	db, e := sql.Open("sqlite", p)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	if _, e = db.Exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE canary(value INTEGER);INSERT INTO canary VALUES(42)"); e != nil {
		t.Fatal(e)
	}

	if _, e = m.Start(Request{OperationID: "wal", BackupSetID: "set", GrantID: "grant", PolicyRevision: 1}); e != nil {
		t.Fatal(e)
	}
	c := waitCapture(t, m, "wal")
	if !c.Coverage.Complete {
		t.Fatalf("WAL not consistent: %+v", c.Coverage)
	}
	dest := filepath.Join(base, "restored")
	if _, e = Unseal(context.Background(), filepath.Join(m.cfg.StagingDir, "wal.age"), key, dest, c.SHA256, RestoreLimits{}); e != nil {
		t.Fatal(e)
	}
	restored, e := sql.Open("sqlite", filepath.Join(dest, "roots", "workspace-123", "wal.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer restored.Close()
	var value int
	if e = restored.QueryRow("SELECT value FROM canary").Scan(&value); e != nil || value != 42 {
		t.Fatal("committed WAL lost", value, e)
	}
}

func TestUnsealRejectsPortableDirectoryCollision(t *testing.T) {
	base := t.TempDir()
	id, e := age.GenerateX25519Identity()
	if e != nil {
		t.Fatal(e)
	}
	key := filepath.Join(base, "key")
	os.WriteFile(key, []byte(id.String()), 0600)
	var buffer bytes.Buffer
	encrypted, e := age.Encrypt(&buffer, id.Recipient())
	if e != nil {
		t.Fatal(e)
	}
	archive := tar.NewWriter(encrypted)
	for _, name := range []string{"roots/project/A", "roots/project/a"} {
		if e = archive.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: 0700}); e != nil {
			t.Fatal(e)
		}
	}
	archive.Close()
	encrypted.Close()
	hash := sha256.Sum256(buffer.Bytes())
	bundle := filepath.Join(base, "collision.age")
	os.WriteFile(bundle, buffer.Bytes(), 0600)
	if _, e = Unseal(context.Background(), bundle, key, filepath.Join(base, "new"), hex.EncodeToString(hash[:]), RestoreLimits{}); e == nil || e.Error() != "portable_archive_name_collision" {
		t.Fatal("portable collision accepted", e)
	}
}
func TestOfflineNativeMetadataApplyAfterAuthentication(t *testing.T) {
	m, base, key := fixture(t, 8192)
	if _, e := m.Start(Request{OperationID: "metadata", BackupSetID: "set", GrantID: "grant", PolicyRevision: 1}); e != nil {
		t.Fatal(e)
	}
	c := waitCapture(t, m, "metadata")
	if _, e := Unseal(context.Background(), filepath.Join(m.cfg.StagingDir, c.ID+".age"), key, filepath.Join(base, "metadata-restored"), c.SHA256, RestoreLimits{ApplyNativeMetadata: true}); e != nil {
		t.Fatal(e)
	}
}

func TestRepeatedProtectedJournalCapturesPreserveLiveWALAndColdRestart(t *testing.T) {
	m, base, _ := fixture(t, 1024)
	m.cfg.LiveSnapshots = map[string]func(context.Context, string, int64) error{filepath.Join(base, "journal.db"): func(ctx context.Context, path string, max int64) error {
		return SnapshotOwnedSQLite(ctx, m.db, path, max)
	}}
	m.cfg.MaxStagingBytes = 10 * m.cfg.MaxBundleBytes
	m.cfg.Roots = append(m.cfg.Roots, Root{ID: "protected-journal", Path: filepath.Join(base, "journal.db"), Kind: "sqlite", Role: "supervisor_state", Required: true, Quiesced: true})
	if _, e := m.db.Exec("CREATE TABLE durability(value INTEGER);INSERT INTO durability VALUES(0)"); e != nil {
		t.Fatal(e)
	}
	walPath := filepath.Join(base, "journal.db-wal")
	before, e := os.Stat(walPath)
	if e != nil {
		t.Fatal(e)
	}
	reader, e := sql.Open("sqlite", filepath.Join(base, "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	reader.SetMaxOpenConns(1)
	defer reader.Close()
	for i := 1; i <= 2; i++ {
		id := "live" + strconv.Itoa(i)
		if _, e = m.Start(Request{OperationID: id, BackupSetID: "set", GrantID: "grant", PolicyRevision: 1}); e != nil {
			t.Fatal(e)
		}
		c := waitCapture(t, m, id)
		if !c.Coverage.Complete {
			t.Fatalf("cut incomplete %+v", c.Coverage)
		}
		after, e := os.Stat(walPath)
		if e != nil || !os.SameFile(before, after) {
			t.Fatal("live WAL removed or replaced", e)
		}
		if _, e = m.db.Exec("INSERT INTO durability VALUES(?)", i); e != nil {
			t.Fatal(e)
		}
		var seen int
		if e = reader.QueryRow("SELECT MAX(value) FROM durability").Scan(&seen); e != nil || seen != i {
			t.Fatal("independent reader lost new committed write", seen, e)
		}
		exe, e := os.Executable()
		if e != nil {
			t.Fatal(e)
		}
		child := exec.Command(exe, "-test.run=^TestExternalSQLiteReaderHelper$")
		child.Env = append(os.Environ(), "HOMELAB_SQLITE_EXTERNAL_READER="+filepath.Join(base, "journal.db"), "HOMELAB_SQLITE_EXPECTED="+strconv.Itoa(i))
		if b, e := child.CombinedOutput(); e != nil {
			t.Fatalf("externalreader: %v %s", e, b)
		}
		after, e = os.Stat(walPath)
		if e != nil || !os.SameFile(before, after) {
			t.Fatal("external reader exposed dropped owner locks/WAL", e)
		}
		deadline := time.Now().Add(time.Second)
		for {
			m.mu.Lock()
			active := m.active
			m.mu.Unlock()
			if active == "" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("capture active not released")
			}
			time.Sleep(time.Millisecond)
		}
	}
	reader.Close()
	if e = m.db.Close(); e != nil {
		t.Fatal(e)
	}
	cold, e := sql.Open("sqlite", filepath.Join(base, "journal.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer cold.Close()
	var rows, seen int
	if e = cold.QueryRow("SELECT COUNT(*),MAX(value) FROM durability").Scan(&rows, &seen); e != nil || rows != 3 || seen != 2 {
		t.Fatal("cold restart lost writes", rows, seen, e)
	}
	if e = cold.QueryRow("SELECT COUNT(*) FROM encrypted_host_captures").Scan(&rows); e != nil || rows != 2 {
		t.Fatal("durable capture receipts lost", rows, e)
	}
}

func TestExternalSQLiteReaderHelper(t *testing.T) {
	p := os.Getenv("HOMELAB_SQLITE_EXTERNAL_READER")
	if p == "" {
		t.Skip("subprocess helper")
	}
	db, e := sql.Open("sqlite", p)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var max int
	if e = db.QueryRow("SELECT MAX(value) FROM durability").Scan(&max); e != nil || strconv.Itoa(max) != os.Getenv("HOMELAB_SQLITE_EXPECTED") {
		t.Fatal("externalreadercommittedvalue", max, e)
	}
}
