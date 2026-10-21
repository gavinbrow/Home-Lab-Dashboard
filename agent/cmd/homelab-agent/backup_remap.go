package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"homelab/agent/internal/transport"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"homelab/agent/internal/backup"
)

// Remapping writes new private configs only. It never starts processes, enables
// execution, rewrites journals or contacts the captured control-plane address.
func backupRemap(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("backup-remap", flag.ContinueOnError)
	directory := fs.String("root", "", "new authenticated offline unseal directory")
	expected := fs.String("ciphertext-sha256", "", "expected encrypted archive hash")
	localURL := fs.String("supervisor-url", "", "explicit new loopback supervisor HTTP URL")
	if e := fs.Parse(args); e != nil {
		return e
	}
	if !filepath.IsAbs(*directory) || len(*expected) != 64 {
		return errors.New("verified_absolute_restore_root_and_hash_required")
	}
	canonical, e := filepath.EvalSymlinks(*directory)
	if e != nil || canonical != *directory {
		return errors.New("restore_root_must_be_canonical")
	}
	root, e := os.OpenRoot(*directory)
	if e != nil {
		return e
	}
	defer root.Close()
	var verified struct {
		Verified     bool   `json:"verified"`
		Hash         string `json:"ciphertext_sha256"`
		ManifestHash string `json:"manifest_sha256"`
	}
	raw, e := root.ReadFile("RESTORE_VERIFIED.json")
	if e != nil || json.Unmarshal(raw, &verified) != nil || !verified.Verified || verified.Hash != *expected {
		return errors.New("authenticated_unseal_marker_required")
	}
	var manifest struct {
		Roots   []backup.Root  `json:"roots"`
		Entries []backup.Entry `json:"entries"`
	}
	raw, e = root.ReadFile("manifest.json")
	if e != nil || len(raw) > 64<<20 {
		return errors.New("invalid_restore_manifest")
	}
	hash := sha256.Sum256(raw)
	if verified.ManifestHash == "" || verified.ManifestHash != hex.EncodeToString(hash[:]) {
		return errors.New("restore_manifest_hash_mismatch")
	}
	if e = json.Unmarshal(raw, &manifest); e != nil {
		return e
	}
	for _, entry := range manifest.Entries {
		if e = ctx.Err(); e != nil {
			return e
		}
		if entry.Kind != "file" {
			continue
		}
		f, e := root.Open(entry.Path)
		if e != nil {
			return e
		}
		h := sha256.New()
		n, e := io.Copy(h, f)
		f.Close()
		if e != nil || n != entry.SizeBytes || hex.EncodeToString(h.Sum(nil)) != entry.SHA256 {
			return errors.New("restore_file_hash_mismatch")
		}
	}
	type mapping struct{ old, new string }
	mappings := []mapping{}
	paths := map[string]string{}
	for _, r := range manifest.Roots {
		destination := filepath.Join(*directory, "roots", r.ID)
		if r.Kind != "directory" {
			destination = filepath.Join(destination, "data")
		}
		paths[r.ID] = destination
		mappings = append(mappings, mapping{filepath.Clean(r.Path), destination})
	}
	sort.SliceStable(mappings, func(i, j int) bool { return len(mappings[i].old) > len(mappings[j].old) })
	remapPath := func(value string) string {
		if !filepath.IsAbs(value) {
			return value
		}
		for _, m := range mappings {
			rel, e := filepath.Rel(m.old, value)
			if e == nil && (rel == "." || filepath.IsLocal(rel)) {
				if rel == "." {
					return m.new
				}
				return filepath.Join(m.new, rel)
			}
		}
		return value
	}
	var transform func(any) any
	transform = func(value any) any {
		switch x := value.(type) {
		case map[string]any:
			for k, v := range x {
				x[k] = transform(v)
			}
			return x
		case []any:
			for i, v := range x {
				x[i] = transform(v)
			}
			return x
		case string:
			return remapPath(x)
		default:
			return value
		}
	}
	writeNew := func(path string, v any) error {
		b, e := json.MarshalIndent(v, "", "  ")
		if e != nil {
			return e
		}
		f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		if _, e = f.Write(b); e == nil {
			e = f.Sync()
		}
		f.Close()
		return e
	}
	loadMap := func(path string) (map[string]any, error) {
		b, e := os.ReadFile(path)
		if e != nil {
			return nil, e
		}
		var value map[string]any
		if e = json.Unmarshal(b, &value); e != nil {
			return nil, e
		}
		return transform(value).(map[string]any), nil
	}
	supervisorPath := paths["supervisor-config"]
	if supervisorPath == "" {
		return errors.New("supervisor_config_not_in_archive")
	}
	cfg, e := loadMap(supervisorPath)
	if e != nil {
		return e
	}
	if list, ok := cfg["workspaces"].([]any); ok {
		for _, item := range list {
			if w, ok := item.(map[string]any); ok {
				if revision, ok := w["revision"].(float64); ok {
					w["revision"] = revision + 1
				}
				w["native_enabled"] = false
				w["container_enabled"] = false
				w["terminal"] = nil
			}
		}
	}
	cfg["require_signed_rpc"] = true
	cfg["recovery_mode"] = true
	if b, ok := cfg["backup"].(map[string]any); ok {
		b["enabled"] = false
	}
	if *localURL != "" {
		u, e := url.Parse(*localURL)
		if e != nil || u.Scheme != "http" || !transport.Loopback(u.Host) || u.Path != "" || u.User != nil {
			return errors.New("explicit_loopback_supervisor_url_required")
		}
		cfg["listen"] = u.Host
	}
	// Reconcile operational binding overlays only. Historical request/receipt JSON
	// remains byte-for-byte untouched, and old current bindings are retained in an
	// append-only recovery audit before their canonical paths/revisions change.
	if dataDir, ok := cfg["data_dir"].(string); ok {
		db, e := sql.Open("sqlite", filepath.Join(dataDir, "journal.db"))
		if e != nil {
			return e
		}
		db.SetMaxOpenConns(1)
		defer db.Close()
		tx, e := db.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		defer tx.Rollback()
		if _, e = tx.Exec(`CREATE TABLE IF NOT EXISTS offline_binding_remaps(workspace_id TEXT NOT NULL,old_binding TEXT NOT NULL,new_binding TEXT NOT NULL,ciphertext_sha256 TEXT NOT NULL,observed_at TEXT NOT NULL)`); e != nil {
			return e
		}
		type row struct{ id, raw string }
		var rows []row
		cursor, e := tx.Query("SELECT workspace_id,binding FROM hostops_bindings")
		if e != nil {
			return e
		}
		for cursor.Next() {
			var r row
			if e = cursor.Scan(&r.id, &r.raw); e != nil {
				cursor.Close()
				return e
			}
			rows = append(rows, r)
		}
		e = cursor.Err()
		cursor.Close()
		if e != nil {
			return e
		}
		for _, r := range rows {
			var value map[string]any
			if e = json.Unmarshal([]byte(r.raw), &value); e != nil {
				return e
			}
			next := transform(value).(map[string]any)
			if list, ok := cfg["workspaces"].([]any); ok {
				for _, v := range list {
					w, ok := v.(map[string]any)
					if ok && w["id"] == r.id {
						next["revision"] = w["revision"]
						next["canonical_root"] = w["root"]
						if w["type"] == "native" {
							next["runtime_path"] = w["root"]
						}
					}
				}
			}
			encoded, e := json.Marshal(next)
			if e != nil {
				return e
			}
			if _, e = tx.Exec("INSERT INTO offline_binding_remaps VALUES(?,?,?,?,?)", r.id, r.raw, string(encoded), *expected, time.Now().UTC().Format(time.RFC3339Nano)); e != nil {
				return e
			}
			if _, e = tx.Exec("UPDATE hostops_bindings SET binding=? WHERE workspace_id=?", string(encoded), r.id); e != nil {
				return e
			}
		}
		if e = tx.Commit(); e != nil {
			return e
		}
	}
	output := filepath.Join(*directory, "recovered-supervisor.json")
	if e = writeNew(output, cfg); e != nil {
		return e
	}
	// Atomic enrollment metadata points at captured versioned key/certificate
	// files in this new root; original escrowed files remain unchanged.
	for id, path := range paths {
		if !strings.Contains(id, "identity") {
			continue
		}
		meta := filepath.Join(path, "identity.json")
		if _, e = os.Stat(meta); e != nil {
			continue
		}
		value, e := loadMap(meta)
		if e != nil {
			return e
		}
		b, _ := json.Marshal(value)
		if e = os.WriteFile(meta, b, 0600); e != nil {
			return e
		}
	}
	if p := paths["connection-config"]; p != "" {
		if *localURL == "" {
			return errors.New("explicit_new_supervisor_url_required")
		}
		connection, e := loadMap(p)
		if e != nil {
			return e
		}
		connection["supervisor_url"] = *localURL
		if e = writeNew(filepath.Join(*directory, "recovered-connection.json"), connection); e != nil {
			return e
		}
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"remapped": true, "supervisor_config": output, "execution_enabled": false, "requires_trust_reconcile": true, "journals_preserved": true, "requires_offline_acl_review": true})
}
