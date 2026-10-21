package native

import (
	"runtime"
	"testing"
)

func TestValidKernelBootIDRejectsLegacyAndMalformedProof(t *testing.T) {
	valid := []string{"osboot-v1:linux:11111111-1111-1111-1111-111111111111", "osboot-v1:windows:22222222-2222-2222-2222-222222222222"}
	for _, id := range valid {
		if !ValidKernelBootID(id) {
			t.Fatal("rejected canonical kernel identity", id)
		}
	}
	invalid := []string{"", "machine:1792554100", "11111111-1111-1111-1111-111111111111", "osboot-v2:linux:11111111-1111-1111-1111-111111111111", "osboot-v1:darwin:11111111-1111-1111-1111-111111111111", "osboot-v1:linux:00000000-0000-0000-0000-000000000000", "osboot-v1:linux:{11111111-1111-1111-1111-111111111111}", "osboot-v1:linux:AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", "osboot-v1:linux:11111111111111111111111111111111", "osboot-v1:linux:11111111-1111-1111-1111-111111111111\n"}
	for _, id := range invalid {
		if ValidKernelBootID(id) {
			t.Fatal("accepted weak/malformed boot proof", id)
		}
	}
}
func TestKernelBootChangedRequiresBothStrongSamePlatformIdentities(t *testing.T) {
	old := "osboot-v1:" + runtime.GOOS + ":11111111-1111-1111-1111-111111111111"
	current := "osboot-v1:" + runtime.GOOS + ":22222222-2222-2222-2222-222222222222"
	if !KernelBootChanged(old, current) {
		t.Fatal("strong same-platform change not recognized")
	}
	otherOS := "linux"
	if runtime.GOOS == "linux" {
		otherOS = "windows"
	}
	foreignOld := "osboot-v1:" + otherOS + ":11111111-1111-1111-1111-111111111111"
	foreignCurrent := "osboot-v1:" + otherOS + ":22222222-2222-2222-2222-222222222222"
	cases := [][2]string{{old, old}, {"", current}, {old, ""}, {"machine:100", current}, {old, "machine:200"}, {"machine:100", "machine:200"}, {old, foreignCurrent}, {foreignOld, foreignCurrent}}
	for _, pair := range cases {
		if KernelBootChanged(pair[0], pair[1]) {
			t.Fatal("untrusted boot mismatch became termination proof", pair)
		}
	}
}
