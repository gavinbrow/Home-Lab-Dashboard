package main

import (
	"runtime"
	"strings"
	"testing"

	"homelab/agent/internal/native"
)

func TestTrustedKernelBootQueryStableWithoutPublishingIdentity(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("OS boot identity unsupported")
	}
	first, err := queryKernelBootIdentity()
	if err != nil {
		t.Fatalf("OS boot identity query unavailable: %v", err)
	}
	second, err := queryKernelBootIdentity()
	if err != nil {
		t.Fatal("second OS boot identity query unavailable")
	}
	if !native.ValidKernelBootID(first) || first != second || !strings.HasPrefix(first, "osboot-v1:"+runtime.GOOS+":") {
		t.Fatal("OS boot identity was invalid or unstable")
	}
}

func TestKernelBootQueryNeverNormalizesLegacyTimeIdentity(t *testing.T) {
	for _, raw := range []string{"", "machine:1792263843", "00000000-0000-0000-0000-000000000000", "osboot-v1:linux:11111111-1111-1111-1111-111111111111", "../boot"} {
		if id, err := kernelBootIdentity(runtime.GOOS, raw); err == nil || id != "" {
			t.Fatal("untrusted or missing boot identity accepted")
		}
	}
}
