package files

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPathValidation(t *testing.T) {
	for _, p := range []string{"../secret", "/absolute", "C:/file", "a\\b", "a/../b", "NUL.txt", "com1", "name:stream", "folder/", "a. ", "\\\\server\\share"} {
		if SafePath(p) == nil {
			t.Error("accepted", p)
		}
	}
	if e := SafePath("nested/正常.txt"); e != nil {
		t.Fatal(e)
	}
}
func TestConditionalWriteAndBinarySnapshot(t *testing.T) {
	dir := t.TempDir()
	r, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	data := []byte{0, 1, 2, 255}
	h, e := r.Write("binary.bin", data, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = r.Write("binary.bin", []byte("overwrite"), nil); e == nil {
		t.Fatal("overwrote existing file without hash")
	}
	old := h
	if _, e = r.Write("binary.bin", []byte("new"), &old); e != nil {
		t.Fatal(e)
	}
	if _, e = r.Write("binary.bin", []byte("stale"), &old); e == nil {
		t.Fatal("stale save allowed")
	}
	snap, e := r.Capture()
	if e != nil || len(snap.Files) != 1 || snap.Consistency != "best_effort" {
		t.Fatal(snap, e)
	}
	if string(snap.Files[0].Bytes) != "new" {
		t.Fatal("snapshot bytes mismatch")
	}
}
func TestEscapeSymlinkRefused(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	os.WriteFile(filepath.Join(outside, "secret"), []byte("not accessible"), 0600)
	if e := os.Symlink(outside, filepath.Join(dir, "escape")); e != nil {
		t.Skip("symlink privilege unavailable", e)
	}
	r, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	if _, e = r.Read("escape/secret"); e == nil {
		t.Fatal("read escaped root")
	}
	if _, e = r.Write("escape/new", []byte("escape"), nil); e == nil {
		t.Fatal("write escaped root")
	}
}
