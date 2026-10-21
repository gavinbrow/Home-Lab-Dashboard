//go:build linux

package native

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
	"os"
)

type linuxTerminal struct{ master *os.File }

func (t *linuxTerminal) Read(b []byte) (int, error)  { return t.master.Read(b) }
func (t *linuxTerminal) Write(b []byte) (int, error) { return t.master.Write(b) }
func (t *linuxTerminal) Close() error                { return t.master.Close() }
func (t *linuxTerminal) Resize(cols, rows uint16) error {
	if cols < 2 || rows < 2 || cols > 500 || rows > 300 {
		return errors.New("terminal_invalid_dimensions")
	}
	return unix.IoctlSetWinsize(int(t.master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Col: cols, Row: rows})
}
func (r *Runner) LaunchTerminal(ctx context.Context, s Spec, cols, rows uint16) (Record, Terminal, error) {
	if e := r.Validate(s); e != nil {
		return Record{}, nil, e
	}
	fd, e := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
	if e != nil {
		return Record{}, nil, e
	}
	master := os.NewFile(uintptr(fd), "restricted-pty-master")
	term := &linuxTerminal{master: master}
	success := false
	defer func() {
		if !success {
			master.Close()
		}
	}()
	if e = unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); e != nil {
		return Record{}, nil, e
	}
	number, e := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if e != nil {
		return Record{}, nil, e
	}
	slavePath := fmt.Sprintf("/dev/pts/%d", number)
	slave, e := unix.Open(slavePath, unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if e != nil {
		return Record{}, nil, e
	}
	defer unix.Close(slave)
	if e = unix.Fchown(slave, int(r.config.UID), int(r.config.GID)); e != nil {
		return Record{}, nil, e
	}
	if e = unix.Fchmod(slave, 0600); e != nil {
		return Record{}, nil, e
	}
	if e = term.Resize(cols, rows); e != nil {
		return Record{}, nil, e
	}
	rec, e := r.launch(ctx, s, slavePath)
	if e != nil {
		return Record{}, nil, e
	}
	success = true
	return rec, term, nil
}
