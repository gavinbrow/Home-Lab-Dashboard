package files

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestStreamingManifestRangesAndPublication(t *testing.T) {
	root := t.TempDir()
	r, e := Open(root)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	data := bytes.Repeat([]byte("x"), MaxFileBytes+13)
	hash := Hash(data)
	if _, e = r.PublishStream(context.Background(), "large.bin", bytes.NewReader(data), int64(len(data)), hash, nil, 64<<20); e != nil {
		t.Fatal(e)
	}
	manifest, e := r.Manifest(context.Background(), 64<<20)
	if e != nil || len(manifest.Manifest) != 1 || manifest.Manifest[0].SHA256 == nil || *manifest.Manifest[0].SHA256 != hash || len(manifest.Exclusions) > 0 {
		t.Fatal(manifest, e)
	}
	part, e := r.ReadRange("large.bin", MaxFileBytes, 100)
	if e != nil || len(part.Content) != 13 || part.SHA256 != Hash(data[MaxFileBytes:]) || part.TotalBytes != int64(len(data)) {
		t.Fatal(part, e)
	}
	if _, e = r.ReadRange("large.bin", 0, MaxRangeBytes+1); e == nil {
		t.Fatal("unbounded range allowed")
	}
	if _, e = r.WriteWithQuota("tiny", []byte("ok"), nil, 64<<20); e != nil {
		t.Fatal("large existing file blocked small edit", e)
	}
	if _, e = r.PublishStream(context.Background(), "large.bin", bytes.NewReader([]byte("no")), 2, Hash([]byte("no")), nil, 64<<20); e == nil {
		t.Fatal("overwrote without content version")
	}
	if _, e = r.PublishStream(context.Background(), "bad", bytes.NewReader(data), int64(len(data)), "bad", nil, 64<<20); e == nil {
		t.Fatal("bad stream digest published")
	}
	if _, e = os.Stat(filepath.Join(root, "bad")); !os.IsNotExist(e) {
		t.Fatal("invalid destination exists", e)
	}
}
