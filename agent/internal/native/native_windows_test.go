//go:build windows

package native

import (
	"context"
	"golang.org/x/sys/windows"
	"testing"
)

func TestWindowsRejectsRestrictiveNetworkBeforeLaunch(t *testing.T) {
	c := testConfig(t)
	r := &Runner{config: c}
	s := testSpec(c)
	s.NetworkPolicy = "none"
	if _, e := r.Launch(context.Background(), s); e == nil {
		t.Fatal("launched unsupported Windows egress policy")
	}
}
func TestWindowsRejectsCurrentIdentity(t *testing.T) {
	c := testConfig(t)
	u, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		t.Fatal(e)
	}
	c.Account = "review-only"
	c.Domain = "."
	c.ExpectedSID = u.User.Sid.String()
	c.PasswordFile = c.SpoolDir + "\\password"
	if _, e = New(c); e == nil {
		t.Fatal("accepted supervisor identity as restricted account")
	}
}
func TestWindowsRestartNeverReattachesPID(t *testing.T) {
	r := &Runner{config: testConfig(t), processes: map[string]*process{}}
	if _, e := r.Inspect(context.Background(), Record{ID: "old", PID: 4, CreatedAt: 1}); e != ErrUnknown {
		t.Fatalf("expected unknown, got %v", e)
	}
}
