package main

import (
	"encoding/json"
	"errors"
	"flag"
	"github.com/google/uuid"
	"homelab/agent/internal/enrollment"
	"homelab/agent/internal/protocol"
	"homelab/agent/internal/supervisor"
	"homelab/agent/internal/transport"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func persistConfigFile(path string, cfg supervisor.Config) error {
	b, e := json.MarshalIndent(cfg, "", "  ")
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".homelab-config-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(name, path)
}
func trustReconcile(args []string) error {
	fs := flag.NewFlagSet("trust-reconcile", flag.ContinueOnError)
	path := fs.String("config", "", "protected supervisor JSON")
	epoch := fs.String("dispatch-epoch", "", "operator-verified restored control-plane UUID")
	pubFile := fs.String("dispatch-public-key-file", "", "operator-verified Ed25519 public key PEM")
	keyID := fs.String("key-id", "", "key identifier matching trusted control plane")
	allow := fs.Bool("allow-unresolved", false, "retain unresolved operations and rotate authority metadata only")
	if e := fs.Parse(args); e != nil {
		return e
	}
	if _, e := uuid.Parse(*epoch); e != nil {
		return errors.New("trusted_dispatch_epoch_uuid_required")
	}
	raw, e := os.ReadFile(*path)
	if e != nil {
		return e
	}
	var cfg supervisor.Config
	if e = json.Unmarshal(raw, &cfg); e != nil {
		return e
	}
	unlock, e := lockState(cfg.DataDir)
	if e != nil {
		return e
	}
	defer unlock()
	keyPEM := ""
	trustedKeyID := cfg.DispatchKeyID
	if *pubFile != "" {
		if !filepath.IsAbs(*pubFile) || *keyID == "" {
			return errors.New("explicit_absolute_public_key_and_key_id_required")
		}
		canonical, e := filepath.EvalSymlinks(*pubFile)
		if e != nil {
			return e
		}
		for _, w := range cfg.Workspaces {
			relative, e := filepath.Rel(w.Root, canonical)
			if e == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))) {
				return errors.New("dispatch_key_must_be_outside_project")
			}
		}
		b, e := os.ReadFile(canonical)
		if e != nil {
			return e
		}
		keyPEM = string(b)
		trustedKeyID = *keyID
		cfg.DispatchPublicKeyFile = canonical
		cfg.DispatchKeyID = *keyID
	} else if cfg.DispatchPublicKeyFile != "" {
		b, e := os.ReadFile(cfg.DispatchPublicKeyFile)
		if e != nil {
			return e
		}
		keyPEM = string(b)
	} else if cfg.IdentityDir != "" {
		identity, e := enrollment.Load(cfg.IdentityDir)
		if e != nil {
			return e
		}
		if identity.DispatchKey != nil {
			trustedKeyID = identity.DispatchKey.KeyID
			keyPEM = identity.DispatchKey.PublicKeyPEM
		}
	}
	if _, e = transport.NewRPCVerifier(trustedKeyID, keyPEM); e != nil {
		return e
	}
	journal, e := supervisor.OpenJournal(filepath.Join(cfg.DataDir, "journal.db"))
	if e != nil {
		return e
	}
	defer journal.Close()
	records, e := journal.All()
	if e != nil {
		return e
	}
	unresolved := 0
	for _, record := range records {
		if !protocol.Terminal(record.Receipt.State) {
			unresolved++
		}
	}
	if unresolved > 0 && !*allow {
		return errors.New("unresolved_operations_require_allow_unresolved_and_explicit_reconciliation")
	}
	oldEpoch := cfg.DispatchEpoch
	cfg.DispatchEpoch = *epoch
	tx, e := journal.DB().Begin()
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.Exec(`CREATE TABLE IF NOT EXISTS trust_reconciliations(observed_at TEXT NOT NULL,old_epoch TEXT NOT NULL,new_epoch TEXT NOT NULL,key_id TEXT NOT NULL,unresolved INTEGER NOT NULL)`); e != nil {
		return e
	}
	if _, e = tx.Exec(`INSERT INTO trust_reconciliations VALUES(?,?,?,?,?)`, time.Now().UTC().Format(time.RFC3339Nano), oldEpoch, *epoch, trustedKeyID, unresolved); e != nil {
		return e
	}
	if _, e = tx.Exec(`UPDATE fences SET epoch=?`, *epoch); e != nil {
		return e
	}
	if e = persistConfigFile(*path, cfg); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return errors.New("trust_commit_interrupted_rerun_same_reconcile_command")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"dispatch_epoch": *epoch, "key_id": trustedKeyID, "unresolved_operations_preserved": unresolved, "commands_replayed": false})
}
