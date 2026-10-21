package backup

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"filippo.io/age"
	"homelab/agent/internal/files"
)

type Entry struct {
	NativeMetadata *files.NativeMetadata `json:"native_metadata,omitempty"`
	Path           string                `json:"path"`
	RootID         string                `json:"root_id"`
	Kind           string                `json:"kind"`
	SizeBytes      int64                 `json:"size_bytes"`
	SHA256         string                `json:"sha256,omitempty"`
	Mode           uint32                `json:"mode"`
	ModifiedAt     string                `json:"modified_at"`
	Consistency    string                `json:"consistency"`
}
type limitedCipher struct {
	file   *os.File
	max, n int64
	hash   io.Writer
}

func (w *limitedCipher) Write(p []byte) (int, error) {
	if int64(len(p)) > w.max-w.n {
		return 0, errors.New("encrypted_bundle_quota")
	}
	n, e := w.file.Write(p)
	w.n += int64(n)
	if n > 0 {
		_, _ = w.hash.Write(p[:n])
	}
	return n, e
}

type captureWriter struct {
	ctx           context.Context
	manager       *Manager
	capture       *Capture
	tar           *tar.Writer
	entries       *os.File
	count         int
	fingerprints  [][32]byte
	metadataBytes int64
	rootMetadata  map[string]files.NativeMetadata
	snapshots     string
}

func (m *Manager) capture(ctx context.Context, c *Capture) error {
	partial := filepath.Join(m.cfg.StagingDir, c.ID+".age.partial")
	out, e := os.OpenFile(partial, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return errors.New("capture_staging_unavailable")
	}
	defer out.Close()
	hash := sha256.New()
	bounded := &limitedCipher{file: out, max: m.cfg.MaxBundleBytes, hash: hash}
	encrypted, e := age.Encrypt(bounded, m.recipient)
	if e != nil {
		return e
	}
	archive := tar.NewWriter(encrypted)
	work, e := os.MkdirTemp(m.cfg.StagingDir, ".plain-"+c.ID+"-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(work)
	entries, e := os.OpenFile(filepath.Join(work, "entries.jsonl"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer entries.Close()
	writer := captureWriter{ctx: ctx, manager: m, capture: c, tar: archive, entries: entries, snapshots: work, rootMetadata: map[string]files.NativeMetadata{}}
	c.Coverage = Coverage{MetadataOmissions: []string{}, Complete: len(m.cfg.MissingComponents) == 0, Components: append([]Component{}, m.cfg.MissingComponents...), Exclusions: []string{}}
	for _, root := range m.cfg.Roots {
		if e = ctx.Err(); e != nil {
			return e
		}
		component := Component{ID: root.ID, Kind: root.Kind, Role: root.Role, State: "captured", Consistency: "managed_writers_quiesced"}
		if root.Role == "project" {
			component.WorkspaceID = strings.TrimPrefix(root.ID, "workspace-")
		}
		if !root.Quiesced {
			component.Consistency = "best_effort"
			component.Reason = "external_writers_not_asserted_quiesced"
			c.Coverage.Complete = false
		}
		before := writer.count
		writer.fingerprints = nil
		e = writer.root(root, true)
		if e != nil {
			if e == errMissingRoot {
				component.State = "missing"
				component.Reason = "required_root_unavailable"
				if !root.Required {
					component.Reason = "optional_root_unavailable"
				}
			} else {
				return fmt.Errorf("fixed_root_capture_failed: %w", e)
			}
			if root.Required {
				c.Coverage.Complete = false
			}
			c.Coverage.Components = append(c.Coverage.Components, component)
			continue
		}
		first := fingerprint(writer.fingerprints)
		writer.fingerprints = nil
		writer.count = before
		e = writer.root(root, false)
		if e != nil || first != fingerprint(writer.fingerprints) {
			component.State = "changed"
			component.Consistency = "best_effort"
			component.Reason = "source_changed_during_capture"
			c.Coverage.Complete = false
		}
		c.Coverage.Components = append(c.Coverage.Components, component)
	}
	if writer.metadataBytes > m.cfg.MaxBundleBytes-(1<<20) {
		return errors.New("backup_manifest_quota")
	}
	if e = entries.Sync(); e != nil {
		return e
	}
	if _, e = entries.Seek(0, io.SeekStart); e != nil {
		return e
	}
	manifest, e := os.OpenFile(filepath.Join(work, "manifest.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	prefix, _ := json.Marshal(map[string]any{"schema_version": 1, "machine_id": m.cfg.MachineID, "boot_id": m.cfg.BootID, "backup_set_id": c.BackupSetID, "captured_at": time.Now().UTC().Format(time.RFC3339Nano), "roots": m.cfg.Roots, "coverage": c.Coverage, "root_native_metadata": writer.rootMetadata})
	if int64(len(prefix))+writer.metadataBytes+32 > m.cfg.MaxBundleBytes {
		return errors.New("backup_manifest_quota")
	}
	if _, e = manifest.Write(append(prefix[:len(prefix)-1], []byte(`,"entries":[`)...)); e != nil {
		manifest.Close()
		return e
	}
	scanner := bufio.NewScanner(entries)
	scanner.Buffer(make([]byte, 65536), 1<<20)
	first := true
	for scanner.Scan() {
		if !first {
			if _, e = manifest.Write([]byte{','}); e != nil {
				manifest.Close()
				return e
			}
		}
		first = false
		if _, e = manifest.Write(scanner.Bytes()); e != nil {
			manifest.Close()
			return e
		}
	}
	if e = scanner.Err(); e != nil {
		manifest.Close()
		return e
	}
	if _, e = manifest.Write([]byte("]}")); e != nil {
		manifest.Close()
		return e
	}
	if e = manifest.Sync(); e != nil {
		manifest.Close()
		return e
	}
	manifest.Close()
	mf, e := os.Open(filepath.Join(work, "manifest.json"))
	if e != nil {
		return e
	}
	info, e := mf.Stat()
	if e != nil {
		mf.Close()
		return e
	}
	if e = archive.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0600, Size: info.Size(), Typeflag: tar.TypeReg}); e != nil {
		mf.Close()
		return e
	}
	_, e = io.Copy(archive, mf)
	mf.Close()
	if e != nil {
		return e
	}
	if e = archive.Close(); e != nil {
		return e
	}
	if e = encrypted.Close(); e != nil {
		return e
	}
	if e = out.Sync(); e != nil {
		return e
	}
	if e = out.Close(); e != nil {
		return e
	}
	if e = os.Rename(partial, filepath.Join(m.cfg.StagingDir, c.ID+".age")); e != nil {
		return e
	}
	c.State = "ready"
	c.CapturedAt = time.Now().UTC().Format(time.RFC3339Nano)
	c.SizeBytes = bounded.n
	c.SHA256 = hex.EncodeToString(hash.Sum(nil))
	c.ChunkSizeBytes = m.cfg.ChunkBytes
	c.ChunkCount = (bounded.n + m.cfg.ChunkBytes - 1) / m.cfg.ChunkBytes
	return nil
}

var errMissingRoot = errors.New("root_missing")

func (w *captureWriter) root(root Root, emit bool) error {
	info, e := os.Lstat(root.Path)
	if errors.Is(e, fs.ErrNotExist) {
		return errMissingRoot
	}
	if e != nil || isLink(info) {
		return errors.New("unsafe_fixed_root")
	}
	canonical, e := filepath.EvalSymlinks(root.Path)
	if e != nil || canonical != root.Path {
		return errors.New("fixed_root_changed")
	}
	if root.Kind == "directory" {
		if !info.IsDir() {
			return errors.New("directory_required")
		}
		handle, e := os.OpenRoot(root.Path)
		if e != nil {
			return e
		}
		defer handle.Close()
		if emit {
			f, e := handle.Open(".")
			if e != nil {
				return e
			}
			metadata, e := files.CaptureFileNativeMetadata(f)
			f.Close()
			if e != nil {
				return e
			}
			w.noteMetadata(metadata)
			w.rootMetadata[root.ID] = metadata
		}
		return w.walk(handle, root, ".", 0, emit)
	}
	if !info.Mode().IsRegular() {
		return errors.New("file_required")
	}
	handle, e := os.OpenRoot(filepath.Dir(root.Path))
	if e != nil {
		return e
	}
	defer handle.Close()
	return w.file(handle, root, filepath.Base(root.Path), "data", info, emit)
}
func (w *captureWriter) excluded(absolute string) bool {
	for _, exclude := range append(w.manager.cfg.ExcludePaths, w.manager.cfg.StagingDir) {
		if absolute == exclude || strings.HasPrefix(absolute, exclude+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}
func (w *captureWriter) walk(handle *os.Root, root Root, rel string, depth int, emit bool) error {
	if depth > 128 {
		return errors.New("backup_depth_limit")
	}
	if e := w.ctx.Err(); e != nil {
		return e
	}
	f, e := handle.Open(rel)
	if e != nil {
		return e
	}
	defer f.Close()
	for {
		entries, e := f.ReadDir(256)
		if e != nil && e != io.EOF {
			return e
		}
		for _, entry := range entries {
			p := path.Join(rel, entry.Name())
			if !safeRelative(p) {
				return errors.New("unsafe_backup_entry")
			}
			absolute := filepath.Join(root.Path, filepath.FromSlash(p))
			if w.excluded(absolute) {
				continue
			}
			if root.Role == "supervisor_state" && p == "supervisor.lock" {
				continue
			}
			info, e := handle.Lstat(p)
			if e != nil {
				return e
			}
			if isLink(info) || !info.Mode().IsRegular() && !info.IsDir() {
				w.capture.Coverage.Complete = false
				if emit {
					w.capture.Coverage.Exclusions = append(w.capture.Coverage.Exclusions, root.ID+":link_or_special_entry")
				}
				continue
			}
			if strings.HasSuffix(p, "-wal") || strings.HasSuffix(p, "-shm") {
				base := strings.TrimSuffix(strings.TrimSuffix(p, "-wal"), "-shm")
				if root.Quiesced && (w.manager.cfg.LiveSnapshots[filepath.Join(root.Path, filepath.FromSlash(base))] != nil || sqliteSource(handle, base)) {
					continue
				}
			}
			if info.IsDir() {
				dir, e := handle.Open(p)
				if e != nil {
					return e
				}
				metadata, e := files.CaptureFileNativeMetadata(dir)
				dir.Close()
				if e != nil {
					return e
				}
				w.noteMetadata(metadata)
				if e = w.add(Entry{NativeMetadata: &metadata, Path: "roots/" + root.ID + "/" + p, RootID: root.ID, Kind: "directory", Mode: uint32(info.Mode().Perm()), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano), Consistency: "file_scan"}, nil, emit); e != nil {
					return e
				}
				if e = w.walk(handle, root, p, depth+1, emit); e != nil {
					return e
				}
			} else if e = w.file(handle, root, p, p, info, emit); e != nil {
				return e
			}
		}
		if e == io.EOF {
			break
		}
	}
	return nil
}
func sqliteSource(handle *os.Root, p string) bool {
	f, e := handle.Open(p)
	if e != nil {
		return false
	}
	defer f.Close()
	var header [16]byte
	_, e = io.ReadFull(f, header[:])
	return e == nil && string(header[:]) == "SQLite format 3\x00"
}
func (w *captureWriter) file(handle *os.Root, root Root, p, archivePath string, info os.FileInfo, emit bool) error {
	if e := w.ctx.Err(); e != nil {
		return e
	}
	absolute := filepath.Join(handle.Name(), filepath.FromSlash(p))
	if snapshot := w.manager.cfg.LiveSnapshots[absolute]; snapshot != nil {
		return w.liveSQLite(root, p, archivePath, absolute, snapshot, emit)
	}
	source, e := openRegular(handle, p)
	if e != nil {
		return e
	}
	defer source.Close()
	opened, e := source.Stat()
	if e != nil || !opened.Mode().IsRegular() || isLink(opened) {
		return errors.New("regular_backup_file_required")
	}
	metadata, e := files.CaptureFileNativeMetadata(source)
	if e != nil {
		return e
	}
	w.noteMetadata(metadata)
	entry := Entry{NativeMetadata: &metadata, Path: "roots/" + root.ID + "/" + archivePath, RootID: root.ID, Kind: "file", Mode: uint32(info.Mode().Perm()), ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano), Consistency: "file_scan"}
	var probe [16]byte
	n, _ := io.ReadFull(source, probe[:])
	if _, e = source.Seek(0, io.SeekStart); e != nil {
		return e
	}
	isSQL := n == 16 && string(probe[:]) == "SQLite format 3\x00"
	if isSQL && !root.Quiesced {
		isSQL = false
		w.capture.Coverage.Complete = false
		if emit {
			w.capture.Coverage.Exclusions = append(w.capture.Coverage.Exclusions, root.ID+":sqlite_requires_external_writer_quiescence")
		}
	}
	if root.Kind == "sqlite" && !isSQL {
		return errors.New("sqlite_source_required")
	}
	if isSQL {
		entry.Consistency = "sqlite_vacuum_into"
		entry.ModifiedAt = ""
		entry.Mode = 0600
		projectFingerprint := ""
		sourcePath := ""
		{
			clone, fingerprint, e := w.cloneProjectSQLite(handle, p, source)
			if e != nil {
				return e
			}
			defer os.RemoveAll(filepath.Dir(clone))
			sourcePath = clone
			projectFingerprint = fingerprint
		}
		if !emit {
			entry.SHA256 = "sqlite_snapshot"
			{
				copy := entry
				copy.Consistency = "quiesced_rooted_sqlite_copy"
				copy.SHA256 = projectFingerprint
				return w.addFingerprint(copy)
			}
		}
		temp, e := os.CreateTemp(w.snapshots, "sqlite-")
		if e != nil {
			return e
		}
		destination := temp.Name()
		temp.Close()
		os.Remove(destination)
		defer os.Remove(destination)
		if sourcePath == "" {
			return errors.New("rooted_sqlite_clone_required")
		}
		uriPath := filepath.ToSlash(sourcePath)
		if filepath.VolumeName(sourcePath) != "" && !strings.HasPrefix(uriPath, "/") {
			uriPath = "/" + uriPath
		}
		uri := (&url.URL{Scheme: "file", Path: uriPath, RawQuery: "mode=ro"}).String()
		db, e := sql.Open("sqlite", uri)
		if e != nil {
			return e
		}
		db.SetMaxOpenConns(1)
		defer db.Close()
		var pages, pageSize int64
		if e = db.QueryRowContext(w.ctx, "PRAGMA page_count").Scan(&pages); e != nil {
			return e
		}
		if e = db.QueryRowContext(w.ctx, "PRAGMA page_size").Scan(&pageSize); e != nil {
			return e
		}
		if pageSize < 1 || pages > w.manager.cfg.MaxBundleBytes/pageSize {
			return errors.New("sqlite_snapshot_quota")
		}
		if _, e = db.ExecContext(w.ctx, `VACUUM INTO ?`, destination); e != nil {
			return e
		}
		snapshot, e := os.Open(destination)
		if e != nil {
			return e
		}
		defer snapshot.Close()
		stat, e := snapshot.Stat()
		if e != nil {
			return e
		}
		entry.SizeBytes = stat.Size()
		entry.SHA256 = "sqlite_snapshot"
		fingerprintEntry := entry
		{
			fingerprintEntry.Consistency = "quiesced_rooted_sqlite_copy"
			fingerprintEntry.SHA256 = projectFingerprint
			fingerprintEntry.SizeBytes = 0
		}
		if e = w.addFingerprint(fingerprintEntry); e != nil {
			return e
		}
		hash, e := hashFile(w.ctx, snapshot)
		if e != nil {
			return e
		}
		entry.SHA256 = hash
		if _, e = snapshot.Seek(0, io.SeekStart); e != nil {
			return e
		}
		return w.emit(entry, snapshot)
	}
	entry.SizeBytes = opened.Size()
	if entry.SizeBytes > w.manager.cfg.MaxBundleBytes {
		return errors.New("backup_file_exceeds_bundle_quota")
	}
	entry.SHA256, e = hashFile(w.ctx, source)
	if e != nil {
		return e
	}
	after, e := source.Stat()
	if e != nil || after.Size() != opened.Size() || !after.ModTime().Equal(opened.ModTime()) {
		return errors.New("source_changed_during_read")
	}
	if _, e = source.Seek(0, io.SeekStart); e != nil {
		return e
	}
	return w.add(entry, source, emit)
}
func (w *captureWriter) addFingerprint(entry Entry) error {
	w.count++
	if w.count > w.manager.cfg.MaxFiles {
		return errors.New("backup_entry_limit")
	}
	copy := entry
	if entry.NativeMetadata != nil {
		md := *entry.NativeMetadata
		md.AccessTime = ""
		if md.NativeTimes != nil {
			times := *md.NativeTimes
			times.Access = 0
			md.NativeTimes = &times
		}
		copy.NativeMetadata = &md
	}
	if copy.Consistency == "sqlite_vacuum_into" {
		copy.SizeBytes = 0
		copy.SHA256 = "sqlite_snapshot"
	}
	raw, _ := json.Marshal(copy)
	w.fingerprints = append(w.fingerprints, sha256.Sum256(raw))
	return nil
}
func (w *captureWriter) add(entry Entry, source io.Reader, emit bool) error {
	if e := w.addFingerprint(entry); e != nil {
		return e
	}
	if emit {
		return w.emit(entry, source)
	}
	return nil
}
func (w *captureWriter) emit(entry Entry, source io.Reader) error {
	raw, e := json.Marshal(entry)
	if e != nil {
		return e
	}
	w.metadataBytes += int64(len(raw)) + 1
	if w.metadataBytes > w.manager.cfg.MaxBundleBytes {
		return errors.New("backup_metadata_quota")
	}
	header := &tar.Header{Name: entry.Path, Mode: int64(entry.Mode), Size: entry.SizeBytes, Typeflag: tar.TypeReg}
	if entry.Kind == "directory" {
		header.Typeflag = tar.TypeDir
		header.Size = 0
	}
	if e := w.tar.WriteHeader(header); e != nil {
		return e
	}
	if source != nil {
		hash := sha256.New()
		if _, e := io.CopyN(io.MultiWriter(w.tar, hash), &contextReader{w.ctx, source}, entry.SizeBytes); e != nil {
			return e
		}
		if hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
			return errors.New("source_changed_during_archive_copy")
		}
	}
	_, e = w.entries.Write(append(raw, byte(10)))
	return e
}
func fingerprint(values [][32]byte) [32]byte {
	sort.Slice(values, func(i, j int) bool { return bytes.Compare(values[i][:], values[j][:]) < 0 })
	hash := sha256.New()
	for _, value := range values {
		hash.Write(value[:])
	}
	var result [32]byte
	copy(result[:], hash.Sum(nil))
	return result
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r *contextReader) Read(p []byte) (int, error) {
	if e := r.ctx.Err(); e != nil {
		return 0, e
	}
	return r.r.Read(p)
}
func hashFile(ctx context.Context, r io.Reader) (string, error) {
	hash := sha256.New()
	if _, e := io.Copy(hash, &contextReader{ctx, r}); e != nil {
		return "", e
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func safeRelative(p string) bool {
	return p != "" && p != "." && !path.IsAbs(p) && !strings.ContainsAny(p, "\\:\x00") && path.Clean(p) == p && p != ".." && !strings.HasPrefix(p, "../") && len(p) <= 4096
}

func (w *captureWriter) noteMetadata(metadata files.NativeMetadata) {
	for _, reason := range metadata.OmittedMetadata {
		if !slices.Contains(w.capture.Coverage.MetadataOmissions, reason) {
			w.capture.Coverage.MetadataOmissions = append(w.capture.Coverage.MetadataOmissions, reason)
		}
	}
}
