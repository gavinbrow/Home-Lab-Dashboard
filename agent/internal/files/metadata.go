package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// NativeMetadata may contain protected extended attributes. Keep it inside the
// authenticated encrypted manifest; never publish or log its attribute values.
type NativeFileTimes struct {
	Creation uint64 `json:"creation"`
	Access   uint64 `json:"access"`
	Write    uint64 `json:"write"`
}
type NativeMetadata struct {
	NativeTimes         *NativeFileTimes  `json:"native_times,omitempty"`
	Version             int               `json:"version"`
	Platform            string            `json:"platform"`
	Kind                string            `json:"kind"`
	Mode                uint32            `json:"mode"`
	UID                 *uint32           `json:"uid,omitempty"`
	GID                 *uint32           `json:"gid,omitempty"`
	OwnerSID            string            `json:"owner_sid,omitempty"`
	GroupSID            string            `json:"group_sid,omitempty"`
	SDDL                string            `json:"sddl,omitempty"`
	DACLProtected       bool              `json:"dacl_protected,omitempty"`
	CreationTime        string            `json:"creation_time,omitempty"`
	AccessTime          string            `json:"access_time,omitempty"`
	ModifiedTime        string            `json:"modified_time"`
	ObjectID            string            `json:"object_id"`
	LinkCount           uint64            `json:"link_count"`
	FileAttributes      uint32            `json:"file_attributes,omitempty"`
	ExtendedAttributes  map[string][]byte `json:"extended_attributes,omitempty"`
	AccessControlXAttrs map[string][]byte `json:"access_control_xattrs,omitempty"`
	OmittedMetadata     []string          `json:"omitted_metadata,omitempty"`
}

// CaptureNativeMetadata is for fixed protected state paths. Project exporters
// should call CaptureFileNativeMetadata on the same rooted handle they copy.
func CaptureNativeMetadata(p string) (NativeMetadata, error) {
	if !filepath.IsAbs(p) || strings.HasPrefix(p, `\\`) || strings.Contains(strings.TrimPrefix(p, filepath.VolumeName(p)), ":") {
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
	if e != nil || isReparse(info) {
		return NativeMetadata{}, errors.New("native_metadata_reparse_denied")
	}
	f, e := os.Open(p)
	if e != nil {
		return NativeMetadata{}, e
	}
	defer f.Close()
	return CaptureFileNativeMetadata(f)
}
func (r *Root) CaptureNativeMetadata(p string) (NativeMetadata, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e := r.rejectLinks(p, false); e != nil {
		return NativeMetadata{}, e
	}
	f, e := openRead(r.root, p)
	if e != nil {
		return NativeMetadata{}, e
	}
	defer f.Close()
	return CaptureFileNativeMetadata(f)
}

// NativeRestorePolicy is supplied only by an offline operator restore flow. No
// RPC or model tool exposes this function or converts a request into this policy.
type NativeRestorePolicy struct {
	Offline                 bool
	ExpectedObjectID        string
	ExpectedContentSHA256   string
	AllowOwnershipChange    bool
	AllowSpecialPermissions bool
}

func validateNativeRestore(f *os.File, metadata NativeMetadata, policy NativeRestorePolicy) (NativeMetadata, error) {
	current, e := CaptureFileNativeMetadata(f)
	if e != nil {
		return current, e
	}
	if !policy.Offline || policy.ExpectedObjectID == "" || current.ObjectID != policy.ExpectedObjectID {
		return current, errors.New("offline_pinned_object_authorization_required")
	}
	if metadata.Version != 1 || metadata.Platform != runtime.GOOS || metadata.Kind != current.Kind {
		return current, errors.New("native_metadata_platform_or_kind_mismatch")
	}
	if metadata.Kind == "file" {
		if len(policy.ExpectedContentSHA256) != 64 {
			return current, errors.New("restore_content_hash_required")
		}
		info, e := f.Stat()
		if e != nil {
			return current, e
		}
		h := sha256.New()
		if _, e = io.Copy(h, io.NewSectionReader(f, 0, info.Size())); e != nil {
			return current, e
		}
		if hex.EncodeToString(h.Sum(nil)) != policy.ExpectedContentSHA256 {
			return current, errors.New("restore_content_hash_mismatch")
		}
	}
	return current, nil
}
