package native

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// Proof records a successful trusted identity/scratch/denied-sentinel probe.
// It is representative verification, not an exhaustive filesystem ACL audit.
type Proof struct {
	ObservedAt   time.Time `json:"observed_at"`
	ConfigDigest string    `json:"config_digest"`
	Identity     string    `json:"identity"`
	Verified     bool      `json:"verified"`
}

var proofSession = func() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		return ""
	}
	return hex.EncodeToString(b)
}()

func (r *Runner) proofDigest() (string, error) {
	if proofSession == "" {
		return "", errors.New("proof_session_unavailable")
	}
	b, e := json.Marshal(r.config)
	if e != nil {
		return "", e
	}
	sum := sha256.Sum256(append(b, []byte(proofSession)...))
	return hex.EncodeToString(sum[:]), nil
}
func (r *Runner) expectedProbeIdentity() string {
	if runtime.GOOS == "windows" {
		return r.config.ExpectedSID
	}
	return strconv.FormatUint(uint64(r.config.UID), 10)
}
func (r *Runner) ValidProof() (Proof, error) {
	b, e := os.ReadFile(filepath.Join(r.config.SpoolDir, "identity-proof.json"))
	if e != nil {
		return Proof{}, e
	}
	var p Proof
	if e = json.Unmarshal(b, &p); e != nil {
		return Proof{}, e
	}
	digest, e := r.proofDigest()
	if e != nil {
		return Proof{}, e
	}
	age := time.Since(p.ObservedAt)
	if !p.Verified || p.ConfigDigest != digest || p.Identity != r.expectedProbeIdentity() || age < 0 || age > 5*time.Minute {
		return Proof{}, errors.New("native_identity_proof_stale_or_config_changed")
	}
	return p, nil
}
func (r *Runner) Verify(ctx context.Context, selfExecutable, denyPath string) (Proof, error) {
	// An explicit recheck invalidates an older green result even if the new
	// helper cannot launch or a permission denial changed outside configuration.
	if e := os.Remove(filepath.Join(r.config.SpoolDir, "identity-proof.json")); e != nil && !os.IsNotExist(e) {
		return Proof{}, e
	}
	if !filepath.IsAbs(selfExecutable) || !filepath.IsAbs(denyPath) {
		return Proof{}, errors.New("probe_absolute_paths_required")
	}
	canonical, e := filepath.EvalSymlinks(selfExecutable)
	if e != nil || canonical != selfExecutable {
		return Proof{}, errors.New("probe_trusted_executable_must_be_canonical")
	}
	for _, root := range []string{r.config.Root, r.config.Scratch} {
		rel, e := filepath.Rel(root, selfExecutable)
		if e != nil || filepath.IsLocal(rel) {
			return Proof{}, errors.New("probe_executable_must_be_outside_writable_roots")
		}
	}
	rel, e := filepath.Rel(r.config.SpoolDir, denyPath)
	if e != nil || !filepath.IsLocal(rel) {
		return Proof{}, errors.New("probe_denied_sentinel_must_be_in_protected_spool")
	}
	canonical, e = filepath.EvalSymlinks(denyPath)
	if e != nil || canonical != denyPath {
		return Proof{}, errors.New("probe_denied_sentinel_must_exist_without_links")
	}
	info, e := os.Stat(denyPath)
	if e != nil || !info.Mode().IsRegular() {
		return Proof{}, errors.New("probe_denied_sentinel_must_be_regular_file")
	}
	nonce := make([]byte, 12)
	if _, e = rand.Read(nonce); e != nil {
		return Proof{}, e
	}
	network := "none"
	if runtime.GOOS == "windows" {
		network = "unrestricted"
	}
	// Linux TasksMax counts Go runtime threads, not only child processes. This
	// fixed trusted probe needs headroom for its runtime; project-command limits
	// remain the separately configured policy and are never widened here.
	spec := Spec{ID: "identity-probe-" + hex.EncodeToString(nonce), Command: selfExecutable, Args: []string{"identity-probe", "--root", r.config.Root, "--scratch", r.config.Scratch, "--deny", denyPath, "--expected-identity", r.expectedProbeIdentity()}, Cwd: r.config.Root, NetworkPolicy: network, Limits: Limits{TimeoutSeconds: 10, MaxOutputBytes: 8192, MemoryBytes: 64 << 20, Pids: 32, CPUPercent: 25}}
	rec, e := r.Launch(ctx, spec)
	if e != nil {
		return Proof{}, e
	}
	waitCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, e := r.Inspect(waitCtx, rec)
		if e != nil {
			return Proof{}, e
		}
		if !status.Exists {
			return Proof{}, ErrUnknown
		}
		if !status.Running {
			if !status.IdentityVerified || status.ExitCode != 0 {
				return Proof{}, errors.New("native_identity_access_probe_failed")
			}
			break
		}
		select {
		case <-waitCtx.Done():
			r.Cancel(context.Background(), rec)
			return Proof{}, waitCtx.Err()
		case <-ticker.C:
		}
	}
	digest, e := r.proofDigest()
	if e != nil {
		return Proof{}, e
	}
	p := Proof{ObservedAt: time.Now().UTC(), ConfigDigest: digest, Identity: r.expectedProbeIdentity(), Verified: true}
	data, e := json.Marshal(p)
	if e != nil {
		return Proof{}, e
	}
	file, e := os.CreateTemp(r.config.SpoolDir, "identity-proof-*.tmp")
	if e != nil {
		return Proof{}, e
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if e = file.Chmod(0600); e == nil {
		_, e = file.Write(data)
	}
	if e == nil {
		e = file.Sync()
	}
	closeError := file.Close()
	if e != nil {
		return Proof{}, e
	}
	if closeError != nil {
		return Proof{}, closeError
	}
	if e = os.Rename(temporary, filepath.Join(r.config.SpoolDir, "identity-proof.json")); e != nil {
		return Proof{}, e
	}
	return p, nil
}
