package files

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNativeAccessControlMetadataFromPinnedHandle(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "private")
	if e := os.WriteFile(p, []byte("private bytes must never enter metadata"), 0600); e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(p)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	meta, e := CaptureFileNativeMetadata(f)
	if e != nil {
		t.Fatal(e)
	}
	if meta.Version != 1 || meta.Platform != runtime.GOOS || meta.ObjectID == "" || meta.Kind != "file" || meta.ModifiedTime == "" {
		t.Fatal("missing native metadata", meta)
	}
	if runtime.GOOS == "windows" {
		if meta.OwnerSID == "" || meta.SDDL == "" {
			t.Fatal("Windows ACL omitted", meta)
		}
	} else if meta.UID == nil || meta.GID == nil || meta.Mode&0777 != 0600 {
		t.Fatal("Linux owner metadata omitted", meta)
	}
	r, e := Open(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	rooted, e := r.CaptureNativeMetadata("private")
	if e != nil || rooted.ObjectID != meta.ObjectID {
		t.Fatal("metadata not bound to same inode", e)
	}
	if _, e = CaptureNativeMetadata("relative"); e == nil {
		t.Fatal("relative native path accepted")
	}
}

func TestOfflinePinnedNativeMetadataRestore(t *testing.T) {
	p := filepath.Join(t.TempDir(), "restore-owned")
	content := []byte("restore proof bytes")
	if e := os.WriteFile(p, content, 0600); e != nil {
		t.Fatal(e)
	}
	f, e := os.OpenFile(p, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	before, e := CaptureFileNativeMetadata(f)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.Chmod(0444); e != nil {
		t.Fatal(e)
	}
	policy := NativeRestorePolicy{ExpectedObjectID: before.ObjectID, ExpectedContentSHA256: Hash(content)}
	if e = RestoreFileNativeMetadata(f, before, policy); e == nil {
		t.Fatal("online metadata mutation allowed")
	}
	policy.Offline = true
	policy.ExpectedObjectID = "wrong-object"
	if e = RestoreFileNativeMetadata(f, before, policy); e == nil {
		t.Fatal("wrong pinned object accepted")
	}
	policy.ExpectedObjectID = before.ObjectID
	policy.ExpectedContentSHA256 = Hash([]byte("other"))
	if e = RestoreFileNativeMetadata(f, before, policy); e == nil {
		t.Fatal("unverified bytes accepted")
	}
	policy.ExpectedContentSHA256 = Hash(content)
	if e = RestoreFileNativeMetadata(f, before, policy); e != nil {
		t.Fatal("offline same-object metadata restore failed", e)
	}
	after, e := CaptureFileNativeMetadata(f)
	if e != nil {
		t.Fatal(e)
	}
	if after.Mode != before.Mode || after.ObjectID != before.ObjectID || after.Platform != before.Platform {
		t.Fatal("access metadata not restored", after.Mode, before.Mode)
	}
	if runtime.GOOS == "windows" && after.OwnerSID != before.OwnerSID {
		t.Fatal("owner SID changed")
	}
	if runtime.GOOS == "linux" && (*after.UID != *before.UID || *after.GID != *before.GID) {
		t.Fatal("owner changed")
	}
}
