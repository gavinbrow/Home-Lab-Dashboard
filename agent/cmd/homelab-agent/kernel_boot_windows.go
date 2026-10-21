//go:build windows

package main

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

func queryKernelBootIdentity() (string, error) {
	// SystemBootEnvironmentInformation exposes a boot GUID, independent of wall
	// clock adjustment. An unavailable/changed API disables boot-only recovery.
	var info struct {
		BootIdentifier windows.GUID
		FirmwareType   uint32
		_              uint32
		BootFlags      uint64
	}
	var returned uint32
	query := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQuerySystemInformation")
	if err := query.Find(); err != nil {
		return "", errors.New("kernel_boot_identity_unavailable")
	}
	status, _, _ := query.Call(90, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info), uintptr(unsafe.Pointer(&returned)))
	if status != 0 || returned < uint32(unsafe.Sizeof(info.BootIdentifier)) {
		return "", errors.New("kernel_boot_identity_unavailable")
	}
	g := info.BootIdentifier
	text := fmt.Sprintf("%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x", g.Data1, g.Data2, g.Data3, g.Data4[0], g.Data4[1], g.Data4[2], g.Data4[3], g.Data4[4], g.Data4[5], g.Data4[6], g.Data4[7])
	return kernelBootIdentity("windows", text)
}
