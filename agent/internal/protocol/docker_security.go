package protocol

import "strings"

// DockerNoNewPrivilegesEnabled recognizes Docker's bare and canonical inspect
// forms of the enabled flag. An ambiguous or malformed occurrence must not
// become proof of isolation merely because another enabled occurrence exists.
func DockerNoNewPrivilegesEnabled(options []string) bool {
	const flag = "no-new-privileges"
	seen := false
	for _, option := range options {
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(option)), flag) {
			continue
		}
		if seen || option != flag && option != flag+":true" && option != flag+"=true" {
			return false
		}
		seen = true
	}
	return seen
}
