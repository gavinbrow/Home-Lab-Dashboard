package files

import (
	"os"
	"path/filepath"
	"testing"
)

func TestOfflineRootedNativeMetadataRestore(t *testing.T) {
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "file"), []byte("proof"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.Mkdir(filepath.Join(dir, "directory"), 0700); e != nil {
		t.Fatal(e)
	}
	root, e := os.OpenRoot(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer root.Close()
	for _, name := range []string{"file", "directory"} {
		t.Run(name, func(t *testing.T) {
			f, e := root.Open(name)
			if e != nil {
				t.Fatal(e)
			}
			defer f.Close()
			metadata, e := CaptureFileNativeMetadata(f)
			if e != nil {
				t.Fatal(e)
			}
			hash := ""
			if name == "file" {
				hash = Hash([]byte("proof"))
			}
			if e = RestoreFileNativeMetadata(f, metadata, NativeRestorePolicy{Offline: true, ExpectedObjectID: metadata.ObjectID, ExpectedContentSHA256: hash}); e != nil {
				t.Fatal(e)
			}
		})
	}
}
