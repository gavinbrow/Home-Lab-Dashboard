//go:build linux

package main

import "os"

func queryKernelBootIdentity() (string, error) {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "", err
	}
	return kernelBootIdentity("linux", string(raw))
}
