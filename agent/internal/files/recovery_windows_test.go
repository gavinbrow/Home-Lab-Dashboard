package files

import (
	"golang.org/x/sys/windows"
	"path/filepath"
	"strings"
	"testing"
)

// An ordinary external application's delete-sharing restriction is a real OS
// publication failure after the first file succeeds, without a test fault hook.
func TestWindowsSharingViolationLeavesExplicitPartialRestore(t *testing.T) {
	dir := t.TempDir()
	r, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	for _, name := range []string{"a-first.txt", "z-locked.txt"} {
		if _, e = r.Write(name, []byte("current"), nil); e != nil {
			t.Fatal(e)
		}
	}
	before, e := r.Capture()
	if e != nil {
		t.Fatal(e)
	}
	name, e := windows.UTF16PtrFromString(filepath.Join(dir, "z-locked.txt"))
	if e != nil {
		t.Fatal(e)
	}
	locked, e := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer windows.CloseHandle(locked)
	hash := Hash([]byte("desired"))
	q := RestoreRequest{ExpectedManifestHash: ManifestHash(before)}
	for _, path := range []string{"a-first.txt", "z-locked.txt"} {
		q.Files = append(q.Files, SnapshotFile{Entry: Entry{Path: path, Kind: "file", SHA256: &hash, SizeBytes: 7, Mode: 0600}, Bytes: []byte("desired")})
	}
	checkpointed := false
	e = r.Restore(q, func(s Snapshot) error { checkpointed = len(s.Files) == 2; return nil })
	if !checkpointed || e == nil || !strings.HasPrefix(e.Error(), "restore_partial:") {
		t.Fatal("real partial effect must retain unknown outcome", checkpointed, e)
	}
	a, ae := r.Read("a-first.txt")
	z, ze := r.Read("z-locked.txt")
	if ae != nil || ze != nil || string(a) != "desired" || string(z) != "current" {
		t.Fatal("unexpected partial bytes", ae, ze)
	}
}
