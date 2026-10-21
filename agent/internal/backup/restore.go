package backup

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filippo.io/age"
	"homelab/agent/internal/files"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type RestoreLimits struct {
	ApplyNativeMetadata     bool
	AllowOwnershipChange    bool
	AllowSpecialPermissions bool
	MaxBytes                int64
	MaxFiles                int
	MaxManifestBytes        int64
}
type RestoreResult struct {
	Files            int    `json:"files"`
	Bytes            int64  `json:"bytes"`
	CiphertextSHA256 string `json:"ciphertext_sha256"`
	Verified         bool   `json:"verified"`
}

func Keygen(privatePath, publicPath string) error {
	identity, e := age.GenerateX25519Identity()
	if e != nil {
		return e
	}
	private, e := os.OpenFile(privatePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	if _, e = io.WriteString(private, identity.String()+"\n"); e != nil {
		private.Close()
		return e
	}
	if e = private.Sync(); e != nil {
		private.Close()
		return e
	}
	if e = private.Close(); e != nil {
		return e
	}
	public, e := os.OpenFile(publicPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer public.Close()
	if _, e = io.WriteString(public, identity.Recipient().String()+"\n"); e != nil {
		return e
	}
	return public.Sync()
}
func Unseal(ctx context.Context, bundle, identityFile, destination, expectedHash string, limits RestoreLimits) (RestoreResult, error) {
	var result RestoreResult
	if len(expectedHash) != 64 {
		return result, errors.New("expected_ciphertext_hash_required")
	}
	if limits.MaxBytes < 1 {
		limits.MaxBytes = 64 << 30
	}
	if limits.MaxFiles < 1 {
		limits.MaxFiles = 100000
	}
	if limits.MaxManifestBytes < 1 {
		limits.MaxManifestBytes = 64 << 20
	}
	if !filepath.IsAbs(destination) {
		return result, errors.New("absolute_new_restore_directory_required")
	}
	canonical, e := filepath.EvalSymlinks(filepath.Dir(destination))
	if e != nil || canonical != filepath.Dir(destination) {
		return result, errors.New("restore_parent_must_be_canonical")
	}
	if _, e = os.Lstat(destination); !errors.Is(e, os.ErrNotExist) {
		return result, errors.New("restore_destination_must_not_exist")
	}
	f, e := os.Open(bundle)
	if e != nil {
		return result, e
	}
	defer f.Close()
	hash, e := hashFile(ctx, f)
	if e != nil {
		return result, e
	}
	if hash != strings.ToLower(expectedHash) {
		return result, errors.New("ciphertext_hash_mismatch")
	}
	if _, e = f.Seek(0, io.SeekStart); e != nil {
		return result, e
	}
	identityRaw, e := os.ReadFile(identityFile)
	if e != nil {
		return result, e
	}
	identity, e := age.ParseX25519Identity(strings.TrimSpace(string(identityRaw)))
	for i := range identityRaw {
		identityRaw[i] = 0
	}
	if e != nil {
		return result, errors.New("invalid_backup_identity")
	}
	plain, e := age.Decrypt(f, identity)
	if e != nil {
		return result, errors.New("bundle_decryption_failed")
	}
	if e = privateDirectory(destination, true); e != nil {
		return result, e
	}
	root, e := os.OpenRoot(destination)
	if e != nil {
		return result, e
	}
	defer root.Close()
	archive := tar.NewReader(&contextReader{ctx, plain})
	entries := map[string]Entry{}
	var manifest struct {
		SchemaVersion      int                             `json:"schema_version"`
		Entries            []Entry                         `json:"entries"`
		RootNativeMetadata map[string]files.NativeMetadata `json:"root_native_metadata"`
	}
	var manifestRaw []byte
	portableNames := map[string]string{}
	manifestSeen := false
	for {
		header, e := archive.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return result, errors.New("invalid_bundle_archive")
		}
		if !safeRelative(header.Name) || files.SafePath(header.Name) != nil || header.Size < 0 || header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir || header.Linkname != "" {
			return result, errors.New("unsafe_bundle_archive_entry")
		}
		if e = claimPortablePath(portableNames, header.Name); e != nil {
			return result, e
		}
		if header.Name == "manifest.json" {
			if manifestSeen || header.Size > limits.MaxManifestBytes {
				return result, errors.New("bundle_manifest_limit")
			}
			raw, e := io.ReadAll(io.LimitReader(archive, limits.MaxManifestBytes+1))
			if e != nil || json.Unmarshal(raw, &manifest) != nil {
				return result, errors.New("invalid_bundle_manifest")
			}
			manifestRaw = raw
			manifestSeen = true
			continue
		}
		if manifestSeen || !strings.HasPrefix(header.Name, "roots/") || len(strings.Split(header.Name, "/")) < 3 || len(entries) >= limits.MaxFiles {
			return result, errors.New("bundle_entry_limit_or_order")
		}
		if _, ok := entries[header.Name]; ok {
			return result, errors.New("duplicate_bundle_entry")
		}
		entry := Entry{Path: header.Name, Kind: "directory"}
		if header.Typeflag == tar.TypeDir {
			if e = root.MkdirAll(header.Name, 0700); e != nil {
				return result, e
			}
			entries[header.Name] = entry
			continue
		}
		if header.Size > limits.MaxBytes-result.Bytes {
			return result, errors.New("restore_byte_limit")
		}
		if e = root.MkdirAll(filepath.ToSlash(filepath.Dir(header.Name)), 0700); e != nil {
			return result, e
		}
		output, e := root.OpenFile(header.Name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return result, e
		}
		h := sha256.New()
		written, e := io.CopyN(io.MultiWriter(output, h), archive, header.Size)
		if e != nil {
			output.Close()
			return result, errors.New("truncated_bundle_file")
		}
		if e = output.Sync(); e != nil {
			output.Close()
			return result, e
		}
		output.Close()
		entry.Kind = "file"
		entry.SizeBytes = written
		entry.SHA256 = hex.EncodeToString(h.Sum(nil))
		entries[header.Name] = entry
		result.Bytes += written
		result.Files++
	}
	if _, e = io.Copy(io.Discard, plain); e != nil {
		return result, errors.New("bundle_authentication_failed")
	}
	if !manifestSeen || manifest.SchemaVersion != 1 || len(manifest.Entries) != len(entries) {
		return result, errors.New("bundle_manifest_entry_mismatch")
	}
	seen := map[string]bool{}
	for _, entry := range manifest.Entries {
		actual, ok := entries[entry.Path]
		if !ok || seen[entry.Path] || actual.Kind != entry.Kind || actual.SizeBytes != entry.SizeBytes || actual.SHA256 != entry.SHA256 {
			return result, errors.New("bundle_file_hash_mismatch")
		}
		seen[entry.Path] = true
	}
	if limits.ApplyNativeMetadata {
		if e = applyNativeMetadata(root, manifest.Entries, manifest.RootNativeMetadata, limits); e != nil {
			return result, e
		}
	}
	if e = root.WriteFile("manifest.json", manifestRaw, 0600); e != nil {
		return result, e
	}
	if e = root.WriteFile("RESTORE_VERIFIED.json", mustJSON(map[string]any{"schema_version": 1, "ciphertext_sha256": hash, "manifest_sha256": func() string { h := sha256.Sum256(manifestRaw); return hex.EncodeToString(h[:]) }(), "verified": true, "requires_operator_path_identity_acl_remap": true, "dispatch_must_remain_disabled": true}), 0600); e != nil {
		return result, e
	}
	result.CiphertextSHA256 = hash
	result.Verified = true
	return result, nil
}
func mustJSON(v any) []byte { b, _ := json.MarshalIndent(v, "", "  "); return b }

func claimPortablePath(names map[string]string, name string) error {
	parts := strings.Split(name, "/")
	for i := range parts {
		part := strings.Join(parts[:i+1], "/")
		key := strings.ToLower(part)
		if old, ok := names[key]; ok && old != part {
			return errors.New("portable_archive_name_collision")
		}
		names[key] = part
	}
	return nil
}
func applyNativeMetadata(root *os.Root, entries []Entry, roots map[string]files.NativeMetadata, limits RestoreLimits) error {
	apply := func(name string, metadata files.NativeMetadata, hash string) error {
		f, e := root.Open(name)
		if e != nil {
			return e
		}
		defer f.Close()
		current, e := files.CaptureFileNativeMetadata(f)
		if e != nil {
			return e
		}
		return files.RestoreFileNativeMetadata(f, metadata, files.NativeRestorePolicy{Offline: true, ExpectedObjectID: current.ObjectID, ExpectedContentSHA256: hash, AllowOwnershipChange: limits.AllowOwnershipChange, AllowSpecialPermissions: limits.AllowSpecialPermissions})
	}
	sort.Slice(entries, func(i, j int) bool { return strings.Count(entries[i].Path, "/") > strings.Count(entries[j].Path, "/") })
	for _, entry := range entries {
		if entry.NativeMetadata == nil {
			return errors.New("archive_native_metadata_missing")
		}
		if e := apply(entry.Path, *entry.NativeMetadata, entry.SHA256); e != nil {
			return e
		}
	}
	for id, metadata := range roots {
		if !validID.MatchString(id) {
			return errors.New("invalid_archive_root_id")
		}
		name := "roots/" + id
		if e := root.MkdirAll(name, 0700); e != nil {
			return e
		}
		if e := apply(name, metadata, ""); e != nil {
			return e
		}
	}
	return nil
}
