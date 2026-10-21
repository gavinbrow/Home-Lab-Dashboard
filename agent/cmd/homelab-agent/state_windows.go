package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
)

func lockState(dir string) (func(), error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	f, e := os.OpenFile(filepath.Join(dir, "supervisor.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	overlap := &windows.Overlapped{}
	if e = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlap); e != nil {
		f.Close()
		return nil, errors.New("supervisor_state_in_use_stop_service_first")
	}
	return func() { windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, overlap); f.Close() }, nil
}
