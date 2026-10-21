package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"homelab/agent/internal/backup"
	"homelab/agent/internal/hostops"
	"homelab/agent/internal/supervisor"
	"homelab/agent/internal/transport"
)

func backupCLI(ctx context.Context, command string, args []string) error {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	if command == "backup-keygen" {
		private := fs.String("identity-file", "", "exclusive new private age identity file; keep offline")
		public := fs.String("recipient-file", "", "exclusive new public age recipient file")
		if e := fs.Parse(args); e != nil {
			return e
		}
		if !filepath.IsAbs(*private) || !filepath.IsAbs(*public) {
			return errors.New("absolute_key_output_paths_required")
		}
		return backup.Keygen(*private, *public)
	}
	bundle := fs.String("bundle", "", "encrypted age bundle path")
	identity := fs.String("identity-file", "", "offline private age identity file")
	output := fs.String("output", "", "exclusive new private restore directory")
	hash := fs.String("sha256", "", "expected whole encrypted bundle SHA256")
	max := fs.Int64("max-bytes", 64<<30, "maximum extracted bytes")
	count := fs.Int("max-files", 100000, "maximum extracted entries")
	apply := fs.Bool("apply-native-metadata", false, "explicit offline same-platform ACL/mode/xattr restore after full authentication")
	owner := fs.Bool("allow-ownership-change", false, "permit original archive owner/group restoration")
	special := fs.Bool("allow-special-permissions", false, "permit original special permissions/capability xattrs")
	if e := fs.Parse(args); e != nil {
		return e
	}
	result, e := backup.Unseal(ctx, *bundle, *identity, *output, *hash, backup.RestoreLimits{MaxBytes: *max, MaxFiles: *count, ApplyNativeMetadata: *apply, AllowOwnershipChange: *owner, AllowSpecialPermissions: *special})
	if e != nil {
		return e
	}
	return json.NewEncoder(os.Stdout).Encode(result)
}

func configureBackup(svc *supervisor.Service, host *hostops.Manager, configPath string) (*backup.Manager, error) {
	cfg := svc.Config.Backup
	if !cfg.Enabled {
		return nil, nil
	}
	if !svc.Config.RequireSignedRPC {
		return nil, errors.New("backup_requires_signed_machine_rpc")
	}
	cfg.MachineID = svc.Config.MachineID
	cfg.BootID = svc.BootID
	cfg.Guard = host.WithStateBackup
	cfg.LiveSnapshots = map[string]func(context.Context, string, int64) error{filepath.Join(svc.Config.DataDir, "journal.db"): func(ctx context.Context, destination string, max int64) error {
		return backup.SnapshotOwnedSQLite(ctx, svc.Journal.DB(), destination, max)
	}}
	if cfg.ConnectionConfigFile != "" {
		raw, e := os.ReadFile(cfg.ConnectionConfigFile)
		if e != nil {
			return nil, e
		}
		var connection transport.ConnectionConfig
		if e = json.Unmarshal(raw, &connection); e != nil {
			return nil, e
		}
		cfg.ExcludePaths = append(cfg.ExcludePaths, filepath.Join(connection.DataDir, "backup-pause.json"), filepath.Join(connection.DataDir, "backup-pause-ack.json"))
		cfg.Guard = func(fn func() error) error {
			duration := time.Duration(cfg.MaxDurationSeconds) * time.Second
			if duration == 0 {
				duration = 4 * time.Hour
			}
			return transport.WithConnectionPaused(context.Background(), connection.DataDir, duration, func() error { return host.WithStateBackup(fn) })
		}
	}
	cfg.Inventory = func() ([]backup.Root, []backup.Component, error) {
		c := svc.Config // Called under hostops+supervisor writer barrier.
		roots := []backup.Root{{ID: "supervisor-state", Path: c.DataDir, Kind: "directory", Role: "supervisor_state", Required: true, Quiesced: true}, {ID: "supervisor-config", Path: configPath, Kind: "file", Role: "config", Required: true, Quiesced: true}, {ID: "local-token", Path: c.LocalTokenFile, Kind: "file", Role: "identity", Required: true, Quiesced: true}}
		missing := []backup.Component{}
		if c.IdentityDir != "" {
			roots = append(roots, backup.Root{ID: "supervisor-identity", Path: c.IdentityDir, Kind: "directory", Role: "identity", Required: true, Quiesced: true})
		} else {
			missing = append(missing, backup.Component{ID: "supervisor-identity", Role: "identity", State: "not_configured", Reason: "enrollment_identity_not_configured"})
		}
		if c.DispatchPublicKeyFile != "" {
			roots = append(roots, backup.Root{ID: "dispatch-key", Path: c.DispatchPublicKeyFile, Kind: "file", Role: "identity", Required: true, Quiesced: true})
		}
		if cfg.ConnectionConfigFile != "" {
			b, e := os.ReadFile(cfg.ConnectionConfigFile)
			if e != nil {
				return nil, nil, errors.New("backup_connection_config_unavailable")
			}
			var connection transport.ConnectionConfig
			if e = json.Unmarshal(b, &connection); e != nil {
				return nil, nil, errors.New("backup_connection_config_invalid")
			}
			if connection.MachineID != c.MachineID {
				return nil, nil, errors.New("backup_connection_machine_mismatch")
			}
			roots = append(roots, backup.Root{ID: "connection-config", Path: cfg.ConnectionConfigFile, Kind: "file", Role: "config", Required: true, Quiesced: true}, backup.Root{ID: "connection-state", Path: connection.DataDir, Kind: "directory", Role: "rpc_spool", Required: true, Quiesced: true}, backup.Root{ID: "connection-identity", Path: connection.IdentityDir, Kind: "directory", Role: "identity", Required: true, Quiesced: true}, backup.Root{ID: "connection-ca", Path: connection.ServerCAFile, Kind: "file", Role: "identity", Required: true, Quiesced: true})
		} else {
			missing = append(missing, backup.Component{ID: "connection-state", Role: "rpc_spool", State: "not_configured", Reason: "connection_config_file_required_for_full_capture"})
		}
		for _, w := range c.Workspaces {
			if w.State == "unregistered" {
				continue
			}
			roots = append(roots, backup.Root{ID: "workspace-" + w.ID, Path: w.Root, Kind: "directory", Role: "project", Required: true, Quiesced: cfg.ExternalWritersQuiesced})
			if w.Native != nil {
				n := w.Native
				roots = append(roots, backup.Root{ID: "native-spool-" + w.ID, Path: n.SpoolDir, Kind: "directory", Role: "execution_spool", Required: true, Quiesced: true})
				if n.PasswordFile != "" {
					roots = append(roots, backup.Root{ID: "native-credential-" + w.ID, Path: n.PasswordFile, Kind: "file", Role: "identity", Required: true, Quiesced: true})
				}
			}
		}
		roots = append(roots, cfg.AdditionalRoots...)
		return roots, missing, nil
	}
	roots, missing, e := cfg.Inventory()
	if e != nil {
		return nil, e
	}
	cfg.Roots = roots
	cfg.MissingComponents = missing
	return backup.New(svc.Journal.DB(), cfg)
}
func registerExtras(host *hostops.Manager, capture *backup.Manager) func(*http.ServeMux) {
	return func(mux *http.ServeMux) {
		host.Register(mux)
		if capture != nil {
			capture.Register(mux)
		}
	}
}
