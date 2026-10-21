package native

import (
	"regexp"
	"runtime"
	"strings"
)

var kernelBootUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ValidKernelBootID recognizes the strong, versioned representation emitted only
// by trusted OS boot-identity queries. It does not authenticate caller input.
// Legacy telemetry timestamps and untyped UUIDs are deliberately not upgraded.
func ValidKernelBootID(id string) bool {
	_, ok := kernelBootOS(id)
	return ok
}

func kernelBootOS(id string) (string, bool) {
	parts := strings.Split(id, ":")
	if len(parts) != 3 || parts[0] != "osboot-v1" || (parts[1] != "linux" && parts[1] != "windows") || !kernelBootUUID.MatchString(parts[2]) || parts[2] == "00000000-0000-0000-0000-000000000000" {
		return "", false
	}
	return parts[1], true
}

// KernelBootChanged is a boot-only termination proof only when both protected
// records came from real kernel queries for this same platform. Query failures,
// legacy estimates and cross-platform records must use OS process/container
// reconciliation instead. These IDs must never be accepted as RPC assertions.
func KernelBootChanged(old, current string) bool {
	oldOS, oldOK := kernelBootOS(old)
	currentOS, currentOK := kernelBootOS(current)
	return oldOK && currentOK && oldOS == currentOS && currentOS == runtime.GOOS && old != current
}
