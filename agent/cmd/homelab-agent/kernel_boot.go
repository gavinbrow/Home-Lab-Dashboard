package main

import (
	"errors"
	"strings"

	"homelab/agent/internal/native"
)

// Only trusted OS query results pass here. Never normalize persisted receipts:
// older machine:epoch-second identities are not proof of a kernel restart.
func kernelBootIdentity(platform, raw string) (string, error) {
	id := "osboot-v1:" + platform + ":" + strings.ToLower(strings.TrimSpace(raw))
	if !native.ValidKernelBootID(id) {
		return "", errors.New("kernel_boot_identity_unavailable")
	}
	return id, nil
}
