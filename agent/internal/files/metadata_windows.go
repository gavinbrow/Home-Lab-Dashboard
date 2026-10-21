package files

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"time"
	"unsafe"
)

// Windows byte-range locks are handle scoped, so metadata capture may safely use
// a separate handle for this fixed administrator-protected path.
func CaptureProtectedPathNativeMetadataNoOpen(p string) (NativeMetadata, error) {
	return CaptureNativeMetadata(p)
}

func CaptureFileNativeMetadata(f *os.File) (NativeMetadata, error) {
	out := NativeMetadata{Version: 1, Platform: "windows", Kind: "file"}
	info, e := f.Stat()
	if e != nil {
		return out, e
	}
	if !info.Mode().IsRegular() && !info.IsDir() {
		return out, errors.New("native_metadata_regular_file_or_directory_required")
	}
	if info.IsDir() {
		out.Kind = "directory"
	}
	handle := windows.Handle(f.Fd())
	var native windows.ByHandleFileInformation
	if e = windows.GetFileInformationByHandle(handle, &native); e != nil {
		return out, e
	}
	if native.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return out, errors.New("native_metadata_reparse_denied")
	}
	descriptor, e := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if e != nil {
		return out, e
	}
	owner, _, e := descriptor.Owner()
	if e != nil {
		return out, e
	}
	group, _, e := descriptor.Group()
	if e != nil {
		return out, e
	}
	out.OwnerSID = owner.String()
	out.GroupSID = group.String()
	out.SDDL = descriptor.String()
	if out.SDDL == "" {
		return out, errors.New("native_metadata_sddl_unavailable")
	}
	control, _, e := descriptor.Control()
	if e != nil {
		return out, e
	}
	out.DACLProtected = control&windows.SE_DACL_PROTECTED != 0
	out.Mode = uint32(info.Mode().Perm())
	out.FileAttributes = native.FileAttributes
	out.LinkCount = uint64(native.NumberOfLinks)
	out.ObjectID = fmt.Sprintf("%d:%08x%08x", native.VolumeSerialNumber, native.FileIndexHigh, native.FileIndexLow)
	out.NativeTimes = &NativeFileTimes{uint64(native.CreationTime.HighDateTime)<<32 | uint64(native.CreationTime.LowDateTime), uint64(native.LastAccessTime.HighDateTime)<<32 | uint64(native.LastAccessTime.LowDateTime), uint64(native.LastWriteTime.HighDateTime)<<32 | uint64(native.LastWriteTime.LowDateTime)}
	out.CreationTime = time.Unix(0, native.CreationTime.Nanoseconds()).UTC().Format(time.RFC3339Nano)
	out.AccessTime = time.Unix(0, native.LastAccessTime.Nanoseconds()).UTC().Format(time.RFC3339Nano)
	out.ModifiedTime = time.Unix(0, native.LastWriteTime.Nanoseconds()).UTC().Format(time.RFC3339Nano)
	out.OmittedMetadata = []string{"windows_sacl_requires_security_privilege", "non_access_control_extended_attributes", "windows_compression_encryption_sparse_storage_attributes"}
	return out, nil
}

// ReOpenFile reopens the pinned object, avoiding a named-path ACL restoration race.
var reopenNativeObject = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReOpenFile")

func RestoreFileNativeMetadata(f *os.File, metadata NativeMetadata, policy NativeRestorePolicy) error {
	current, e := validateNativeRestore(f, metadata, policy)
	if e != nil {
		return e
	}
	descriptor, e := windows.SecurityDescriptorFromString(metadata.SDDL)
	if e != nil {
		return e
	}
	owner, _, e := descriptor.Owner()
	if e != nil {
		return e
	}
	group, _, e := descriptor.Group()
	if e != nil {
		return e
	}
	if owner == nil || group == nil || owner.String() != metadata.OwnerSID || group.String() != metadata.GroupSID {
		return errors.New("native_security_descriptor_identity_mismatch")
	}
	dacl, _, e := descriptor.DACL()
	if e != nil {
		return e
	}
	if dacl == nil && !policy.AllowSpecialPermissions {
		return errors.New("permissive_acl_restore_not_authorized")
	}
	control, _, e := descriptor.Control()
	if e != nil {
		return e
	}
	if (control&windows.SE_DACL_PROTECTED != 0) != metadata.DACLProtected {
		return errors.New("native_security_descriptor_control_mismatch")
	}
	ownership := metadata.OwnerSID != current.OwnerSID || metadata.GroupSID != current.GroupSID
	if ownership && !policy.AllowOwnershipChange {
		return errors.New("ownership_restore_not_authorized")
	}
	raw := metadata.NativeTimes
	if raw == nil {
		parse := func(value string) (uint64, error) {
			stamp, e := time.Parse(time.RFC3339Nano, value)
			if e != nil {
				return 0, e
			}
			ft := windows.NsecToFiletime(stamp.UnixNano())
			return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime), nil
		}
		c, e := parse(metadata.CreationTime)
		if e != nil {
			return e
		}
		a, e := parse(metadata.AccessTime)
		if e != nil {
			return e
		}
		w, e := parse(metadata.ModifiedTime)
		if e != nil {
			return e
		}
		raw = &NativeFileTimes{c, a, w}
	}
	desired := uint32(windows.READ_CONTROL | windows.WRITE_DAC | windows.FILE_READ_ATTRIBUTES | windows.FILE_WRITE_ATTRIBUTES)
	if ownership {
		desired |= windows.WRITE_OWNER
	}
	var handle windows.Handle
	if current.Kind == "directory" {
		// ReOpenFile rejects directory handles opened through Go's rooted NT
		// APIs. An empty relative NT name reopens this pinned directory itself;
		// no mutable named path is resolved.
		name, err := windows.NewNTUnicodeString("")
		if err != nil {
			return err
		}
		attributes := windows.OBJECT_ATTRIBUTES{RootDirectory: windows.Handle(f.Fd()), ObjectName: name}
		attributes.Length = uint32(unsafe.Sizeof(attributes))
		var status windows.IO_STATUS_BLOCK
		if e = windows.NtCreateFile(&handle, desired, &attributes, &status, nil, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, windows.FILE_OPEN, windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_FOR_BACKUP_INTENT|windows.FILE_OPEN_REPARSE_POINT, 0, 0); e != nil {
			return fmt.Errorf("native_metadata_reopen_directory: %w", e)
		}
	} else {
		h, _, callErr := reopenNativeObject.Call(uintptr(f.Fd()), uintptr(desired), uintptr(windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE), uintptr(windows.FILE_FLAG_BACKUP_SEMANTICS))
		if h == uintptr(windows.InvalidHandle) {
			if callErr != windows.ERROR_SUCCESS {
				return fmt.Errorf("native_metadata_reopen: %w", callErr)
			}
			return windows.ERROR_INVALID_HANDLE
		}
		handle = windows.Handle(h)
	}
	defer windows.CloseHandle(handle)
	var actual windows.ByHandleFileInformation
	if e = windows.GetFileInformationByHandle(handle, &actual); e != nil {
		return e
	}
	if actual.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || fmt.Sprintf("%d:%08x%08x", actual.VolumeSerialNumber, actual.FileIndexHigh, actual.FileIndexLow) != policy.ExpectedObjectID {
		return errors.New("native_pinned_object_changed")
	}
	info := windows.DACL_SECURITY_INFORMATION
	if metadata.DACLProtected {
		info |= windows.PROTECTED_DACL_SECURITY_INFORMATION
	} else {
		info |= windows.UNPROTECTED_DACL_SECURITY_INFORMATION
	}
	var nextOwner, nextGroup *windows.SID
	if metadata.OwnerSID != current.OwnerSID {
		info |= windows.OWNER_SECURITY_INFORMATION
		nextOwner = owner
	}
	if metadata.GroupSID != current.GroupSID {
		info |= windows.GROUP_SECURITY_INFORMATION
		nextGroup = group
	}
	if e = windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.SECURITY_INFORMATION(info), nextOwner, nextGroup, dacl, nil); e != nil {
		return fmt.Errorf("native_metadata_set_security: %w", e)
	}
	ft := func(n uint64) windows.Filetime {
		return windows.Filetime{LowDateTime: uint32(n), HighDateTime: uint32(n >> 32)}
	}
	creation, access, write := ft(raw.Creation), ft(raw.Access), ft(raw.Write)
	if e = windows.SetFileTime(handle, &creation, &access, &write); e != nil {
		return fmt.Errorf("native_metadata_set_times: %w", e)
	}
	attrs := metadata.FileAttributes & uint32(windows.FILE_ATTRIBUTE_READONLY|windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM|windows.FILE_ATTRIBUTE_ARCHIVE|windows.FILE_ATTRIBUTE_TEMPORARY|windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)
	if attrs == 0 {
		attrs = windows.FILE_ATTRIBUTE_NORMAL
	}
	basic := struct {
		Creation, Access, Write, Change int64
		Attributes                      uint32
	}{Attributes: attrs}
	if e = windows.SetFileInformationByHandle(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); e != nil {
		return fmt.Errorf("native_metadata_set_attributes: %w", e)
	}
	return nil
}
