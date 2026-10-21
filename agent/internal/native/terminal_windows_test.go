//go:build windows

package native

import (
	"context"
	"golang.org/x/sys/windows"
	"testing"
)

func TestConPTYRejectsPolicyBeforeAnyAccountLaunch(t *testing.T) {
	r := &Runner{config: testConfig(t)}
	s := testSpec(r.config)
	s.NetworkPolicy = "none"
	if _, _, e := r.LaunchTerminal(context.Background(), s, 80, 24); e == nil {
		t.Fatal("accepted unenforced restrictive network policy")
	}
}
func TestConPTYSDKCreateResizeWithoutLaunchingUserCode(t *testing.T) {
	if e := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); e != nil {
		t.Skip("ConPTY unavailable on this Windows build")
	}
	var inputRead, inputWrite, outputRead, outputWrite windows.Handle
	if e := windows.CreatePipe(&inputRead, &inputWrite, nil, 0); e != nil {
		t.Fatal(e)
	}
	defer windows.CloseHandle(inputRead)
	defer windows.CloseHandle(inputWrite)
	if e := windows.CreatePipe(&outputRead, &outputWrite, nil, 0); e != nil {
		t.Fatal(e)
	}
	defer windows.CloseHandle(outputRead)
	defer windows.CloseHandle(outputWrite)
	var pc windows.Handle
	if e := windows.CreatePseudoConsole(windows.Coord{X: 80, Y: 24}, inputRead, outputWrite, 0, &pc); e != nil {
		t.Fatal(e)
	}
	defer windows.ClosePseudoConsole(pc)
	if e := windows.ResizePseudoConsole(pc, windows.Coord{X: 100, Y: 35}); e != nil {
		t.Fatal(e)
	}
	t.Log("ConPTY API create/resize/close passed; no child process or alternate-account proof claimed")
}
