// Package native launches commands using explicitly provisioned OS identities.
// Working directories and process grouping are not filesystem security boundaries.
package native

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type Config struct {
	Root         string `json:"root"`
	Scratch      string `json:"scratch"`
	SpoolDir     string `json:"spool_dir"`
	UID          uint32 `json:"uid"`
	GID          uint32 `json:"gid"`
	Account      string `json:"account"`
	Domain       string `json:"domain"`
	ExpectedSID  string `json:"expected_sid"`
	PasswordFile string `json:"password_file"`
	ACLReviewed  bool   `json:"acl_reviewed"`
	SystemdRun   string `json:"systemd_run"`
	Systemctl    string `json:"systemctl"`
}
type Limits struct {
	TimeoutSeconds              int
	MaxOutputBytes, MemoryBytes int64
	Pids, CPUPercent            int
}
type Spec struct {
	ID, Command, Cwd string
	Args             []string
	Env              map[string]string
	Limits           Limits
	NetworkPolicy    string
}
type Record struct {
	ID, ContainerID, InvocationID, Identity, OutputPath string
	PID                                                 uint32
	CreatedAt                                           uint64
	Deadline                                            time.Time
}
type Status struct {
	Exists, Running  bool
	ExitCode         int
	IdentityVerified bool
	Reason           string
	ExitCodeUnknown  bool
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
var ErrUnknown = errors.New("native_outcome_unknown_no_replay")

func validateConfig(c Config) error {
	if !c.ACLReviewed {
		return errors.New("native_account_acl_review_required")
	}
	for _, p := range []string{c.Root, c.Scratch, c.SpoolDir} {
		if !filepath.IsAbs(p) || strings.ContainsAny(p, "\x00\r\n%") {
			return errors.New("native_absolute_canonical_paths_required")
		}
		resolved, e := filepath.EvalSymlinks(p)
		matches := filepath.Clean(resolved) == filepath.Clean(p)
		if runtime.GOOS == "windows" {
			matches = strings.EqualFold(filepath.Clean(resolved), filepath.Clean(p))
		}
		if e != nil || !matches {
			return errors.New("native_paths_must_exist_without_links")
		}
		info, e := os.Stat(p)
		if e != nil || !info.IsDir() {
			return errors.New("native_directory_required")
		}
	}
	for _, writable := range []string{c.Root, c.Scratch} {
		rel, e := filepath.Rel(writable, c.SpoolDir)
		if e != nil || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
			return errors.New("native_spool_must_be_outside_writable_roots")
		}
	}
	return nil
}
func validate(c Config, s Spec) error {
	if !validID.MatchString(s.ID) || !filepath.IsAbs(s.Command) || s.Cwd != c.Root || len(s.Env) != 0 || len(s.Args) > 1024 {
		return errors.New("native_invalid_command_or_environment")
	}
	for _, v := range append([]string{s.Command}, s.Args...) {
		if strings.ContainsRune(v, 0) {
			return errors.New("native_nul_in_command")
		}
	}
	l := s.Limits
	if l.TimeoutSeconds < 1 || l.TimeoutSeconds > 86400 || l.MaxOutputBytes < 1 || l.MaxOutputBytes > 1<<30 || l.MemoryBytes < 16<<20 || l.Pids < 1 || l.Pids > 4096 || l.CPUPercent < 1 || l.CPUPercent > 100 {
		return errors.New("native_invalid_limits")
	}
	if s.NetworkPolicy != "none" && s.NetworkPolicy != "unrestricted" {
		return errors.New("native_network_policy_unsupported")
	}
	return nil
}
func (r *Runner) ReadLogs(ctx context.Context, rec Record, max int64) ([]byte, bool, error) {
	if e := ctx.Err(); e != nil {
		return nil, false, e
	}
	if max < 1 || max > 1<<30 {
		return nil, false, errors.New("invalid_log_limit")
	}
	expected := filepath.Join(r.config.SpoolDir, rec.ID+".log")
	if !validID.MatchString(rec.ID) || rec.OutputPath != expected {
		return nil, false, errors.New("native_log_identity_mismatch")
	}
	// Spool directory must be inaccessible to the execution account, as reviewed
	// during enrollment. No execution-account path is followed here.
	f, e := os.Open(expected)
	if e != nil {
		return nil, false, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil {
		return nil, false, e
	}
	truncated := int64(len(b)) >= max
	if truncated {
		b = b[:max]
	}
	return b, truncated, nil
}
