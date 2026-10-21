package files

import (
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func CaptureFileNativeMetadata(f *os.File) (NativeMetadata, error) {
	info, e := f.Stat()
	if e != nil {
		return NativeMetadata{}, e
	}
	return captureLinuxMetadata(info, func(dst []byte) (int, error) { return unix.Flistxattr(int(f.Fd()), dst) }, func(name string, dst []byte) (int, error) { return unix.Fgetxattr(int(f.Fd()), name, dst) })
}

// CaptureProtectedPathNativeMetadataNoOpen is restricted to fixed administrator-
// protected paths. It must never open/close the live database inode: closing any
// descriptor for it can release this process's POSIX advisory SQLite locks.
// Project paths must use the rooted, pinned-handle capture API instead.
func CaptureProtectedPathNativeMetadataNoOpen(p string) (NativeMetadata, error) {
	if !filepath.IsAbs(p) || filepath.Clean(p) != p {
		return NativeMetadata{}, errors.New("native_metadata_path_invalid")
	}
	canonical, e := filepath.EvalSymlinks(p)
	if e != nil {
		return NativeMetadata{}, e
	}
	if canonical != p {
		return NativeMetadata{}, errors.New("native_metadata_symlink_denied")
	}
	info, e := os.Lstat(p)
	if e != nil {
		return NativeMetadata{}, e
	}
	out, e := captureLinuxMetadata(info, func(dst []byte) (int, error) { return unix.Llistxattr(p, dst) }, func(name string, dst []byte) (int, error) { return unix.Lgetxattr(p, name, dst) })
	if e != nil {
		return out, e
	}
	after, e := os.Lstat(p)
	if e != nil {
		return out, e
	}
	if !os.SameFile(info, after) || isReparse(after) {
		return NativeMetadata{}, errors.New("native_metadata_protected_object_changed")
	}
	return out, nil
}

func captureLinuxMetadata(info os.FileInfo, list func([]byte) (int, error), get func(string, []byte) (int, error)) (NativeMetadata, error) {
	out := NativeMetadata{Version: 1, Platform: "linux", Kind: "file", OmittedMetadata: []string{"linux_birth_time", "linux_filesystem_inode_flags"}}
	if !info.Mode().IsRegular() && !info.IsDir() || isReparse(info) {
		return out, errors.New("native_metadata_regular_file_or_directory_required")
	}
	if info.IsDir() {
		out.Kind = "directory"
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return out, errors.New("native_metadata_stat_unavailable")
	}
	uid, gid := stat.Uid, stat.Gid
	out.UID = &uid
	out.GID = &gid
	out.Mode = stat.Mode & 07777
	out.LinkCount = uint64(stat.Nlink)
	out.ObjectID = fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)
	out.ModifiedTime = info.ModTime().UTC().Format(time.RFC3339Nano)
	out.AccessTime = time.Unix(stat.Atim.Sec, stat.Atim.Nsec).UTC().Format(time.RFC3339Nano)
	out.ExtendedAttributes = map[string][]byte{}
	out.AccessControlXAttrs = map[string][]byte{}
	namesSize, e := list(nil)
	if errors.Is(e, unix.ENOTSUP) {
		return out, nil
	}
	if e != nil {
		return out, e
	}
	if namesSize > 64<<10 {
		return out, errors.New("native_extended_attribute_name_limit")
	}
	names := make([]byte, namesSize)
	if namesSize > 0 {
		n, e := list(names)
		if e != nil {
			return out, e
		}
		names = names[:n]
	}
	count := 0
	total := 0
	for _, name := range strings.Split(string(names), "\x00") {
		if name == "" {
			continue
		}
		count++
		if count > 1024 {
			return out, errors.New("native_extended_attribute_count_limit")
		}
		size, e := get(name, nil)
		if e != nil {
			return out, e
		}
		if size > 256<<10 || total+size > 1<<20 {
			return out, errors.New("native_extended_attribute_value_limit")
		}
		value := make([]byte, size)
		n, e := get(name, value)
		if e != nil {
			return out, e
		}
		out.ExtendedAttributes[name] = value[:n]
		total += n
		if name == "system.posix_acl_access" || name == "system.posix_acl_default" || name == "security.selinux" {
			out.AccessControlXAttrs[name] = value[:n]
		}
	}
	return out, nil
}

// RestoreFileNativeMetadata applies captured metadata to this already pinned
// object, after byte-hash and explicit offline operator checks.
func RestoreFileNativeMetadata(f *os.File, metadata NativeMetadata, policy NativeRestorePolicy) error {
	current, e := validateNativeRestore(f, metadata, policy)
	if e != nil {
		return e
	}
	if metadata.UID == nil || metadata.GID == nil || metadata.Mode&^uint32(07777) != 0 {
		return errors.New("native_posix_metadata_invalid")
	}
	wanted := metadata.ExtendedAttributes
	if wanted == nil {
		wanted = metadata.AccessControlXAttrs
	}
	if !policy.AllowSpecialPermissions && (metadata.Mode&07000 != 0 || len(wanted["security.capability"]) > 0) {
		return errors.New("special_permissions_restore_not_authorized")
	}
	ownership := *metadata.UID != *current.UID || *metadata.GID != *current.GID
	if ownership && !policy.AllowOwnershipChange {
		return errors.New("ownership_restore_not_authorized")
	}
	total := 0
	for name, value := range wanted {
		if name == "" || strings.ContainsRune(name, 0) || len(name) > 255 || len(value) > 256<<10 {
			return errors.New("native_extended_attribute_invalid")
		}
		total += len(value)
		if total > 1<<20 {
			return errors.New("native_extended_attribute_value_limit")
		}
	}
	modified, e := time.Parse(time.RFC3339Nano, metadata.ModifiedTime)
	if e != nil {
		return e
	}
	access, e := time.Parse(time.RFC3339Nano, metadata.AccessTime)
	if e != nil {
		return e
	}
	if ownership {
		if e = f.Chown(int(*metadata.UID), int(*metadata.GID)); e != nil {
			return e
		}
	}
	mode := fs.FileMode(metadata.Mode & 0777)
	if metadata.Mode&04000 != 0 {
		mode |= os.ModeSetuid
	}
	if metadata.Mode&02000 != 0 {
		mode |= os.ModeSetgid
	}
	if metadata.Mode&01000 != 0 {
		mode |= os.ModeSticky
	}
	if e = f.Chmod(mode); e != nil {
		return e
	}
	for name := range current.ExtendedAttributes {
		if _, exists := wanted[name]; !exists {
			if e = unix.Fremovexattr(int(f.Fd()), name); e != nil && !errors.Is(e, unix.ENODATA) {
				return e
			}
		}
	}
	for name, value := range wanted {
		if e = unix.Fsetxattr(int(f.Fd()), name, value, 0); e != nil {
			return e
		}
	}
	times := []unix.Timespec{unix.NsecToTimespec(access.UnixNano()), unix.NsecToTimespec(modified.UnixNano())}
	if e = unix.UtimesNanoAt(int(f.Fd()), "", times, unix.AT_EMPTY_PATH); e != nil {
		return e
	}
	return nil
}
