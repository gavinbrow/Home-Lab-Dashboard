package main

import (
	"encoding/json"
	"errors"
	"flag"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

func identityProbe(args []string) error {
	fs := flag.NewFlagSet("identity-probe", flag.ContinueOnError)
	root := fs.String("root", "", "")
	scratch := fs.String("scratch", "", "")
	deny := fs.String("deny", "", "")
	expected := fs.String("expected-identity", "", "")
	if e := fs.Parse(args); e != nil {
		return e
	}
	current, e := user.Current()
	if e != nil || !strings.EqualFold(current.Uid, *expected) {
		return errors.New("execution_identity_mismatch")
	}
	for _, dir := range []string{*root, *scratch} {
		if !filepath.IsAbs(dir) {
			return errors.New("probe_absolute_root_required")
		}
		f, e := os.CreateTemp(dir, ".homelab-identity-probe-")
		if e != nil {
			return errors.New("scoped_write_denied")
		}
		name := f.Name()
		if _, e = f.Write([]byte("identity probe\n")); e != nil {
			f.Close()
			os.Remove(name)
			return e
		}
		if e = f.Sync(); e != nil {
			f.Close()
			os.Remove(name)
			return e
		}
		f.Close()
		if e = os.Remove(name); e != nil {
			return errors.New("scoped_cleanup_denied")
		}
	}
	f, e := os.Open(*deny)
	if e == nil {
		f.Close()
		return errors.New("protected_read_was_not_denied")
	}
	if !errors.Is(e, os.ErrPermission) {
		return errors.New("protected_read_probe_invalid")
	}
	f, e = os.CreateTemp(filepath.Dir(*deny), ".homelab-denied-write-probe-")
	if e == nil {
		name := f.Name()
		f.Close()
		os.Remove(name)
		return errors.New("protected_write_was_not_denied")
	}
	if !errors.Is(e, os.ErrPermission) {
		return errors.New("protected_write_probe_invalid")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"identity": current.Uid, "scoped_write": true, "protected_read_denied": true, "protected_write_denied": true})
}
