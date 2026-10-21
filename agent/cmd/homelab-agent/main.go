package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"homelab/agent/internal/enrollment"
	"homelab/agent/internal/files"
	"homelab/agent/internal/hostops"
	"homelab/agent/internal/supervisor"
	"homelab/agent/internal/telemetry"
	"homelab/agent/internal/terminal"
	"homelab/agent/internal/transport"
)

func main() {
	if e := run(); e != nil {
		var exit exitStatusError
		if errors.As(e, &exit) {
			os.Exit(exit.Code)
		}
		log.Print(e)
		os.Exit(1)
	}
}
func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runCommand(ctx, os.Args[1:])
}
func runCommand(ctx context.Context, args []string) error {
	if len(args) < 1 {
		return errors.New("usage: homelab-agent collect|agent|supervisor [flags]")
	}
	switch args[0] {
	case "terminal-container-stop":
		fs := flag.NewFlagSet("terminal-container-stop", flag.ContinueOnError)
		state := fs.String("state", "", "protected container terminal state file")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		return terminal.RunContainerStopHelper(*state)
	case "backup-remap":
		return backupRemap(ctx, args[1:])
	case "backup-keygen", "backup-unseal":
		return backupCLI(ctx, args[0], args[1:])
	case "trust-reconcile":
		return trustReconcile(args[1:])
	case "service":
		return runService(args[1:])
	case "container-run":
		return containerRun(args[1:])
	case "identity-probe":
		return identityProbe(args[1:])
	case "enroll":
		fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
		endpoint := fs.String("endpoint", "", "explicit pinned HTTPS enrollment endpoint")
		ca := fs.String("ca", "", "pinned server CA file")
		machine := fs.String("machine-id", "", "pending enrolled machine UUID")
		dir := fs.String("identity-dir", "", "protected absolute identity directory")
		tokenFile := fs.String("token-file", "", "protected one-use token file")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		token, e := os.ReadFile(*tokenFile)
		if e != nil {
			return e
		}
		client, e := enrollment.BootstrapClient(*ca)
		if e != nil {
			return e
		}
		id, e := enrollment.Enroll(ctx, client, *endpoint, *dir, *machine, strings.TrimSpace(string(token)))
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"machine_id": id.MachineID, "expires_at": id.ExpiresAt, "serial": id.Serial, "relay_configured": id.DispatchKey != nil})
	case "connect":
		fs := flag.NewFlagSet("connect", flag.ContinueOnError)
		path := fs.String("config", "", "protected connection config JSON")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		f, e := os.Open(*path)
		if e != nil {
			return e
		}
		defer f.Close()
		var cfg transport.ConnectionConfig
		decoder := json.NewDecoder(f)
		decoder.DisallowUnknownFields()
		if e = decoder.Decode(&cfg); e != nil {
			return e
		}
		return transport.RunConnection(ctx, cfg)
	case "collect", "agent":
		fs := flag.NewFlagSet("collect", flag.ContinueOnError)
		machine := fs.String("machine-id", "", "enrolled stable machine ID")
		endpoint := fs.String("endpoint", "", "explicit configured telemetry HTTPS endpoint (agent mode)")
		ca := fs.String("ca", "", "trusted CA PEM file")
		cert := fs.String("cert", "", "machine certificate PEM file")
		key := fs.String("key", "", "machine private key PEM file")
		nvidia := fs.String("nvidia-smi", "", "explicit executable path; empty disables GPU adapter")
		cpuWindow := fs.Duration("cpu-window", 200*time.Millisecond, "CPU observation interval; diagnostic collect mode only")
		cpuEvidence := fs.String("cpu-evidence-file", "", "exclusive new absolute CPU timing-only evidence JSON")
		interval := fs.Duration("interval", 5*time.Second, "sample interval (minimum 1s)")
		dataDir := fs.String("data-dir", "", "protected absolute directory for durable telemetry sequence")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		if *machine == "" {
			return errors.New("machine_id_required")
		}
		collector := telemetry.New()
		collector.NvidiaSMI = *nvidia
		if *cpuWindow < 50*time.Millisecond || *cpuWindow > 10*time.Second {
			return errors.New("cpu_window_out_of_bounds")
		}
		if args[0] == "collect" {
			collector.CPUWindow = *cpuWindow
			sample := collector.Collect(ctx, *machine)
			if *cpuEvidence != "" {
				if !filepath.IsAbs(*cpuEvidence) {
					return errors.New("absolute_cpu_evidence_path_required")
				}
				f, e := os.OpenFile(*cpuEvidence, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
				if e != nil {
					return e
				}
				e = json.NewEncoder(f).Encode(map[string]any{"cpu_started_at": collector.CPUStartedAt.Format(time.RFC3339Nano), "cpu_completed_at": collector.CPUCompletedAt.Format(time.RFC3339Nano), "cpu_window_seconds": cpuWindow.Seconds()})
				if e == nil {
					e = f.Sync()
				}
				f.Close()
				if e != nil {
					return e
				}
			}
			return json.NewEncoder(os.Stdout).Encode(sample)
		}
		if *interval < time.Second {
			return errors.New("interval_too_short")
		}
		if !filepath.IsAbs(*dataDir) {
			return errors.New("protected_absolute_data_dir_required")
		}
		sequence, e := telemetry.OpenSequence(filepath.Join(*dataDir, "telemetry.db"))
		if e != nil {
			return e
		}
		defer sequence.Close()
		client, e := transport.MTLSClient(*ca, *cert, *key)
		if e != nil {
			return e
		}
		ticker := time.NewTicker(*interval)
		defer ticker.Stop()
		for {
			sample := collector.Collect(ctx, *machine)
			sample.Sequence, e = sequence.Next()
			if e != nil {
				return errors.New("telemetry_sequence_storage_failed")
			}
			if e = transport.Post(ctx, client, *endpoint, sample); e != nil {
				log.Print(e)
			}
			select {
			case <-ctx.Done():
				return nil
			case <-ticker.C:
			}
		}
	case "supervisor":
		fs := flag.NewFlagSet("supervisor", flag.ContinueOnError)
		config := fs.String("config", "", "protected local configuration JSON")
		if e := fs.Parse(args[1:]); e != nil {
			return e
		}
		f, e := os.Open(*config)
		if e != nil {
			return e
		}
		defer f.Close()
		var cfg supervisor.Config
		d := json.NewDecoder(f)
		d.DisallowUnknownFields()
		if e = d.Decode(&cfg); e != nil {
			return e
		}
		if !transport.Loopback(cfg.Listen) || cfg.MachineID == "" || cfg.DispatchEpoch == "" || !filepath.IsAbs(cfg.DataDir) {
			return errors.New("invalid_supervisor_configuration")
		}
		unlock, e := lockState(cfg.DataDir)
		if e != nil {
			return e
		}
		defer unlock()
		token, e := os.ReadFile(cfg.LocalTokenFile)
		if e != nil {
			return e
		}
		secret := strings.TrimSpace(string(token))
		if len(secret) < 32 {
			return errors.New("local_token_too_short")
		}
		journal, e := supervisor.OpenJournal(filepath.Join(cfg.DataDir, "journal.db"))
		if e != nil {
			return e
		}
		defer journal.Close()
		kernelBoot, bootErr := queryKernelBootIdentity()
		if bootErr != nil {
			// Missing trusted boot evidence never falls back to clock time. Normal
			// containment inspection remains available; boot-only release does not.
			log.Print("kernel_boot_identity_unavailable_boot_recovery_disabled")
		}
		self, e := os.Executable()
		if e != nil {
			return e
		}
		svc := &supervisor.Service{Config: cfg, Journal: journal, Backend: supervisor.Docker{Executable: cfg.DockerPath, HelperPath: self}, BootID: kernelBoot}
		svc.ExecutablePath, e = os.Executable()
		if e != nil {
			return e
		}
		local := &transport.Local{Supervisor: svc, Token: secret, Roots: map[string]*files.Root{}, Writable: map[string]bool{}}
		local.RequireSignedRPC = cfg.RequireSignedRPC
		var dispatchKeyID, dispatchPublicPEM string
		generation := cfg.MachineIdentityGeneration
		if cfg.IdentityDir != "" {
			id, e := enrollment.Load(cfg.IdentityDir)
			if e != nil {
				return e
			}
			if id.MachineID != cfg.MachineID {
				return errors.New("supervisor_identity_machine_mismatch")
			}
			if generation != "" && generation != id.MachineIdentityGeneration {
				return errors.New("configured_identity_generation_mismatch")
			}
			generation = id.MachineIdentityGeneration
			if id.DispatchKey != nil {
				dispatchKeyID = id.DispatchKey.KeyID
				dispatchPublicPEM = id.DispatchKey.PublicKeyPEM
			}
		}
		if cfg.DispatchPublicKeyFile != "" {
			public, e := os.ReadFile(cfg.DispatchPublicKeyFile)
			if e != nil {
				return e
			}
			dispatchKeyID = cfg.DispatchKeyID
			dispatchPublicPEM = string(public)
		}
		if dispatchPublicPEM != "" {
			local.Verifier, e = transport.NewRPCVerifier(dispatchKeyID, dispatchPublicPEM)
			if e != nil {
				return e
			}
			local.Verifier.DispatchEpoch = cfg.DispatchEpoch
			local.Verifier.MachineIdentityGeneration = generation
			local.Relay, e = transport.OpenRelayStore(journal.DB())
			if e != nil {
				return e
			}
		}
		svc.Config.MachineIdentityGeneration = generation
		cfg.MachineIdentityGeneration = generation
		if local.RequireSignedRPC && local.Verifier == nil {
			return errors.New("signed_dispatch_public_key_required")
		}
		for _, w := range cfg.Workspaces {
			root, e := files.Open(w.Root)
			if e != nil {
				return fmt.Errorf("workspace %s: %w", w.ID, e)
			}
			defer root.Close()
			local.Roots[w.ID] = root
			local.Writable[w.ID] = w.Writable
		}
		hostConfig := hostops.Config{MachineIdentityGeneration: generation, MachineID: cfg.MachineID, DispatchEpoch: cfg.DispatchEpoch, DataDir: cfg.DataDir, DockerPath: cfg.DockerPath, SystemctlPath: cfg.SystemctlPath, SCPath: cfg.SCPath, JournalctlPath: cfg.JournalctlPath, Targets: cfg.Targets}
		for _, w := range cfg.Workspaces {
			approved := w.ApprovedRootID
			if approved == "" {
				approved = w.ID
			}
			kind := w.Type
			if kind == "" {
				kind = "native"
				if w.ContainerEnabled {
					kind = "container"
				}
			}
			runtimePath := w.RuntimePath
			if runtimePath == "" {
				runtimePath = w.Root
				if kind == "container" {
					runtimePath = "/workspace/project"
				}
			}
			var envID *string
			var generation *int
			if w.EnvironmentID != "" {
				v := w.EnvironmentID
				envID = &v
				g := w.EnvironmentGeneration
				generation = &g
			}
			hostConfig.Workspaces = append(hostConfig.Workspaces, hostops.WorkspaceBinding{WorkspaceID: w.ID, State: w.State, ApprovedRootID: approved, CanonicalRoot: w.Root, RuntimePath: runtimePath, Type: kind, Writable: w.Writable, QuotaBytes: w.QuotaBytes, Revision: w.Revision, EnvironmentID: envID, EnvironmentGeneration: generation, ImageDigest: w.Image, RuntimeID: w.RuntimeID, DeletionGrantID: w.DeletionGrantID, RecoveryGrantID: w.RecoveryGrantID, PolicyRevision: w.PolicyRevision, EnvironmentGrantIDs: w.EnvironmentGrantIDs, ContainerUser: w.User, CPUs: w.CPUs, MemoryBytes: w.MemoryBytes, PidsLimit: w.PidsLimit, Command: w.EnvironmentCommand})
		}
		hostConfig.OnEnvironmentChange = func(binding hostops.WorkspaceBinding) error {
			return svc.ApplyEnvironmentLocked(binding, func(next supervisor.Config) error { return persistConfigFile(*config, next) })
		}
		hostConfig.WithJournalBackup = svc.WithJournalBackup
		hostManager, e := hostops.New(journal.DB(), hostConfig, local.Roots, svc.WithWorkspaceMutation)
		if e != nil {
			return e
		}
		svc.ExternalWorkspaceBusy = hostManager.WorkspaceBusy
		local.ExternalFileWrites = true
		capture, e := configureBackup(svc, hostManager, *config)
		if e != nil {
			return e
		}
		local.RegisterExtra = registerExtras(hostManager, capture)
		for _, binding := range hostManager.CurrentBindings() {
			if e = svc.ApplyEnvironmentLocked(binding, nil); e != nil {
				return e
			}
		}
		if e = svc.RecoverTerminals(); e != nil {
			return e
		}
		defer svc.CloseTerminals()
		server := &http.Server{Addr: cfg.Listen, Handler: local.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192}
		errorsOut := make(chan error, 2)
		go func() { errorsOut <- svc.Run(ctx) }()
		if local.Relay != nil {
			go func() {
				ticker := time.NewTicker(time.Second)
				defer ticker.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
						if e := svc.WithStateMaintenance(local.Relay.ScrubTransientOutputs); e != nil {
							errorsOut <- errors.New("relay_cache_scrub_failed")
							return
						}
					}
				}
			}()
		}
		go func() { errorsOut <- server.ListenAndServe() }()
		select {
		case <-ctx.Done():
		case e = <-errorsOut:
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdown)
		if e == http.ErrServerClosed || e == context.Canceled {
			return nil
		}
		return e
	default:
		return errors.New("unknown_mode")
	}
}
