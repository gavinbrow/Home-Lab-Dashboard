package main

import (
	"errors"
	"golang.org/x/sys/unix"
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
	if e = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); e != nil {
		f.Close()
		return nil, errors.New("supervisor_state_in_use_stop_service_first")
	}
	return func() { unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
}
