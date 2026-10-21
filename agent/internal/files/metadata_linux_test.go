package files

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
)

func TestProtectedNoOpenMetadataPreservesPOSIXLocks(t *testing.T) {
	// A separate process is required: POSIX locks belong to the process, not
	// individual handles, so a same-process second SQL connection misses this.
	if p := os.Getenv("HLD_METADATA_LOCK_PROBE"); p != "" {
		f, e := os.OpenFile(p, os.O_RDWR, 0)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		lock := unix.Flock_t{Type: unix.F_WRLCK, Whence: 0, Start: 0, Len: 1}
		e = unix.FcntlFlock(f.Fd(), unix.F_SETLK, &lock)
		if !errors.Is(e, unix.EAGAIN) && !errors.Is(e, unix.EACCES) {
			t.Fatal("parent POSIX lock lost", e)
		}
		return
	}
	p := filepath.Join(t.TempDir(), "owned-journal.db")
	f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if _, e = f.Write([]byte("metadata lock proof")); e != nil {
		t.Fatal(e)
	}
	lock := unix.Flock_t{Type: unix.F_WRLCK, Whence: 0, Start: 0, Len: 1}
	if e = unix.FcntlFlock(f.Fd(), unix.F_SETLK, &lock); e != nil {
		t.Fatal(e)
	}
	metadata, e := CaptureProtectedPathNativeMetadataNoOpen(p)
	if e != nil {
		t.Fatal(e)
	}
	if metadata.Kind != "file" || metadata.UID == nil || metadata.GID == nil || metadata.ObjectID == "" {
		t.Fatal("incomplete protected metadata")
	}
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command(exe, "-test.run=^TestProtectedNoOpenMetadataPreservesPOSIXLocks$", "-test.count=1")
	cmd.Env = append(os.Environ(), "HLD_METADATA_LOCK_PROBE="+p)
	if out, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("external lock probe: %v: %s", e, out)
	}
}

func TestOfflineRestoreIncludesBoundedOrdinaryXattrs(t *testing.T) {
	p := filepath.Join(t.TempDir(), "xattr-owned")
	data := []byte("owned xattr proof")
	if e := os.WriteFile(p, data, 0600); e != nil {
		t.Fatal(e)
	}
	f, e := os.OpenFile(p, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	name := "user.homelab_restore_proof"
	if e = unix.Fsetxattr(int(f.Fd()), name, []byte("before"), 0); e == unix.ENOTSUP {
		t.Skip("filesystem lacks xattrs")
	} else if e != nil {
		t.Fatal(e)
	}
	snapshot, e := CaptureFileNativeMetadata(f)
	if e != nil {
		t.Fatal(e)
	}
	if string(snapshot.ExtendedAttributes[name]) != "before" {
		t.Fatal("ordinary xattr omitted")
	}
	if !slices.Contains(snapshot.OmittedMetadata, "linux_birth_time") || !slices.Contains(snapshot.OmittedMetadata, "linux_filesystem_inode_flags") {
		t.Fatal("unmodeled native metadata not disclosed")
	}
	_ = unix.Fsetxattr(int(f.Fd()), name, []byte("after"), 0)
	_ = unix.Fsetxattr(int(f.Fd()), "user.extra_restore_proof", []byte("extra"), 0)
	policy := NativeRestorePolicy{Offline: true, ExpectedObjectID: snapshot.ObjectID, ExpectedContentSHA256: Hash(data)}
	if e = RestoreFileNativeMetadata(f, snapshot, policy); e != nil {
		t.Fatal(e)
	}
	restored, e := CaptureFileNativeMetadata(f)
	if e != nil {
		t.Fatal(e)
	}
	if string(restored.ExtendedAttributes[name]) != "before" {
		t.Fatal("xattr not restored")
	}
	if _, exists := restored.ExtendedAttributes["user.extra_restore_proof"]; exists {
		t.Fatal("unexpected xattr retained")
	}
}
