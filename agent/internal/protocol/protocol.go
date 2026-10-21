// Package protocol mirrors packages/contracts/src/index.ts. Wire changes require
// coordination with the contracts owner, not independent Go schema evolution.
package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"time"
	"unicode/utf16"
)

type Limits struct {
	MaxToolSteps             int   `json:"max_tool_steps"`
	WallTimeSeconds          int   `json:"wall_time_seconds"`
	PerCommandTimeoutSeconds int   `json:"per_command_timeout_seconds"`
	MaxOutputBytes           int64 `json:"max_output_bytes"`
}
type Grant struct {
	ID           string    `json:"id"`
	OwnerID      string    `json:"owner_id"`
	Revision     int       `json:"revision"`
	Tools        []string  `json:"tools"`
	MachineIDs   []string  `json:"machine_ids"`
	WorkspaceIDs []string  `json:"workspace_ids"`
	ProfileIDs   *[]string `json:"profile_ids,omitempty"`
	SecretIDs    *[]string `json:"secret_ids,omitempty"`
	ExpiresAt    *string   `json:"expires_at"`
	RevokedAt    *string   `json:"revoked_at"`
}
type Command struct {
	Executable string            `json:"executable"`
	Args       []string          `json:"args"`
	Cwd        string            `json:"cwd"`
	Env        map[string]string `json:"env"`
}
type NetworkPolicy struct {
	Mode         string   `json:"mode"`
	AllowedHosts []string `json:"allowed_hosts"`
}
type SavedAction struct {
	ActionID       string `json:"action_id"`
	Revision       int    `json:"revision"`
	DefinitionHash string `json:"definition_hash"`
}
type Request struct {
	MachineIdentityGeneration string         `json:"machine_identity_generation,omitempty"`
	SchemaVersion             int            `json:"schema_version"`
	OperationID               string         `json:"operation_id"`
	RequestHash               string         `json:"request_hash"`
	JobID                     string         `json:"job_id"`
	StepID                    string         `json:"step_id"`
	MachineID                 string         `json:"machine_id"`
	ExecutionIdentityID       string         `json:"execution_identity_id"`
	WorkspaceID               string         `json:"workspace_id"`
	WorkspaceRevision         int            `json:"workspace_revision"`
	EnvironmentID             *string        `json:"environment_id"`
	EnvironmentGeneration     *int           `json:"environment_generation"`
	PolicyRevision            int            `json:"policy_revision"`
	Fence                     int64          `json:"fence"`
	DispatchEpoch             string         `json:"dispatch_epoch"`
	Grant                     Grant          `json:"grant"`
	Command                   Command        `json:"command"`
	Limits                    Limits         `json:"limits"`
	NetworkPolicy             *NetworkPolicy `json:"network_policy,omitempty"`
	SavedAction               *SavedAction   `json:"saved_action,omitempty"`
}
type Receipt struct {
	SchemaVersion int     `json:"schema_version"`
	OperationID   string  `json:"operation_id"`
	RequestHash   string  `json:"request_hash"`
	MachineID     string  `json:"machine_id"`
	HostSequence  int64   `json:"host_sequence"`
	State         string  `json:"state"`
	ObservedAt    string  `json:"observed_at"`
	BootID        string  `json:"boot_id"`
	ProcessID     *int    `json:"process_id,omitempty"`
	ExitCode      *int    `json:"exit_code,omitempty"`
	Reason        *string `json:"reason,omitempty"`
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

var stepIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$`)

func ValidID(s string) bool { return identifier.MatchString(s) }
func Hash(r Request) (string, error) {
	b, e := json.Marshal(r)
	if e != nil {
		return "", e
	}
	var m map[string]any
	if e = json.Unmarshal(b, &m); e != nil {
		return "", e
	}
	delete(m, "request_hash")
	delete(m, "fence")
	delete(m, "dispatch_epoch")
	canonical, e := CanonicalJSON(m)
	if e != nil {
		return "", e
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

// CanonicalJSON matches the shared contracts' lexicographically sorted compact JSON.
func CanonicalJSON(value any) ([]byte, error) {
	encoded, e := json.Marshal(value)
	if e != nil {
		return nil, e
	}
	var m any
	if e = json.Unmarshal(encoded, &m); e != nil {
		return nil, e
	}
	var out bytes.Buffer
	if e = canonicalValue(&out, m); e != nil {
		return nil, e
	}
	return out.Bytes(), nil
}
func canonicalValue(out *bytes.Buffer, v any) error {
	switch value := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(i, j int) bool {
			a, ae := strconv.ParseUint(keys[i], 10, 32)
			b, be := strconv.ParseUint(keys[j], 10, 32)
			ai := ae == nil && a < 4294967295 && strconv.FormatUint(a, 10) == keys[i]
			bi := be == nil && b < 4294967295 && strconv.FormatUint(b, 10) == keys[j]
			if ai != bi {
				return ai
			}
			if ai {
				return a < b
			}
			x, y := utf16.Encode([]rune(keys[i])), utf16.Encode([]rune(keys[j]))
			for n := 0; n < len(x) && n < len(y); n++ {
				if x[n] != y[n] {
					return x[n] < y[n]
				}
			}
			return len(x) < len(y)
		})
		out.WriteByte('{')
		for i, key := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			if e := canonicalValue(out, key); e != nil {
				return e
			}
			out.WriteByte(':')
			if e := canonicalValue(out, value[key]); e != nil {
				return e
			}
		}
		out.WriteByte('}')
	case []any:
		out.WriteByte('[')
		for i, x := range value {
			if i > 0 {
				out.WriteByte(',')
			}
			if e := canonicalValue(out, x); e != nil {
				return e
			}
		}
		out.WriteByte(']')
	default:
		var b bytes.Buffer
		encoder := json.NewEncoder(&b)
		encoder.SetEscapeHTML(false)
		if e := encoder.Encode(value); e != nil {
			return e
		}
		out.Write(bytes.TrimSuffix(b.Bytes(), []byte{'\n'}))
	}
	return nil
}
func (r Request) Validate() error {
	if r.SavedAction != nil {
		if !ValidID(r.SavedAction.ActionID) || r.SavedAction.Revision < 1 || len(r.SavedAction.DefinitionHash) != 64 {
			return errors.New("invalid_saved_action")
		}
		if _, e := hex.DecodeString(r.SavedAction.DefinitionHash); e != nil {
			return errors.New("invalid_saved_action")
		}
	}
	if r.SchemaVersion != 1 || !ValidID(r.OperationID) || !ValidID(r.JobID) || !stepIdentifier.MatchString(r.StepID) || !ValidID(r.MachineID) || !ValidID(r.WorkspaceID) || r.Fence < 1 || r.WorkspaceRevision < 1 || r.PolicyRevision < 1 {
		return errors.New("invalid_request")
	}
	if r.Limits.MaxToolSteps < 1 || r.Limits.MaxToolSteps > 1000 || r.Limits.PerCommandTimeoutSeconds < 1 || r.Limits.PerCommandTimeoutSeconds > 3600 || r.Limits.WallTimeSeconds < 1 || r.Limits.WallTimeSeconds > 86400 || r.Limits.MaxOutputBytes < 1 || r.Limits.MaxOutputBytes > 1<<30 {
		return errors.New("invalid_limits")
	}
	if r.Command.Executable == "" || len(r.Command.Executable) > 4096 || len(r.Command.Args) > 1024 {
		return errors.New("invalid_command")
	}
	if r.Grant.RevokedAt != nil {
		return errors.New("grant_revoked")
	}
	if r.Grant.ExpiresAt != nil {
		t, e := time.Parse(time.RFC3339, *r.Grant.ExpiresAt)
		if e != nil || !t.After(time.Now()) {
			return errors.New("grant_expired")
		}
	}
	h, e := Hash(r)
	if e != nil {
		return e
	}
	if h != r.RequestHash {
		return errors.New("request_hash_mismatch")
	}
	return nil
}
func Terminal(s string) bool {
	switch s {
	case "succeeded", "failed", "cancelled", "interrupted", "rejected":
		return true
	}
	return false
}
