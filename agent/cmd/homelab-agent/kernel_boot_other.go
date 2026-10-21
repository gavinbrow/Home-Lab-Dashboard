//go:build !linux && !windows

package main

import "errors"

func queryKernelBootIdentity() (string, error) {
	return "", errors.New("kernel_boot_identity_unavailable")
}
