//go:build windows

package native

import (
	"context"
	"errors"
	"golang.org/x/sys/windows"
	"io"
	"os"
	"sync"
)

type windowsTerminal struct {
	mu            sync.Mutex
	handle        windows.Handle
	input, output *os.File
	closed        bool
	finished      bool
}

func (t *windowsTerminal) Read(b []byte) (int, error)  { return t.output.Read(b) }
func (t *windowsTerminal) Write(b []byte) (int, error) { return t.input.Write(b) }
func (t *windowsTerminal) Resize(cols, rows uint16) error {
	if cols < 2 || rows < 2 || cols > 500 || rows > 300 {
		return errors.New("terminal_invalid_dimensions")
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed || t.finished {
		return os.ErrClosed
	}
	return windows.ResizePseudoConsole(t.handle, windows.Coord{X: int16(cols), Y: int16(rows)})
}
func (t *windowsTerminal) Close() error {
	t.Finish()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	return t.output.Close()
}

// Finish closes the console's producer while preserving the output reader so
// its final VT frame can drain before the manager closes that pipe.
func (t *windowsTerminal) Finish() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.finished {
		return nil
	}
	t.finished = true
	t.input.Close()
	windows.ClosePseudoConsole(t.handle)
	return nil
}
func (r *Runner) LaunchTerminal(ctx context.Context, s Spec, cols, rows uint16) (Record, Terminal, error) {
	if e := r.Validate(s); e != nil {
		return Record{}, nil, e
	}
	if cols < 2 || rows < 2 || cols > 500 || rows > 300 {
		return Record{}, nil, errors.New("terminal_invalid_dimensions")
	}
	// No host console/account is used as a fallback when ConPTY is unavailable.
	if e := windows.NewLazySystemDLL("kernel32.dll").NewProc("CreatePseudoConsole").Find(); e != nil {
		return Record{}, nil, errors.New("windows_conpty_requires_supported_os_build")
	}
	var inputRead, inputWrite, outputRead, outputWrite windows.Handle
	if e := windows.CreatePipe(&inputRead, &inputWrite, nil, 0); e != nil {
		return Record{}, nil, e
	}
	defer windows.CloseHandle(inputRead)
	if e := windows.CreatePipe(&outputRead, &outputWrite, nil, 0); e != nil {
		windows.CloseHandle(inputWrite)
		return Record{}, nil, e
	}
	defer windows.CloseHandle(outputWrite)
	term := &windowsTerminal{input: os.NewFile(uintptr(inputWrite), "conpty-input"), output: os.NewFile(uintptr(outputRead), "conpty-output")}
	if e := windows.CreatePseudoConsole(windows.Coord{X: int16(cols), Y: int16(rows)}, inputRead, outputWrite, 0, &term.handle); e != nil {
		term.input.Close()
		term.output.Close()
		return Record{}, nil, e
	}
	rec, e := r.launch(ctx, s, term)
	if e != nil {
		go io.Copy(io.Discard, term.output) // ConPTY teardown must have an output drain.
		term.Close()
		return Record{}, nil, e
	}
	return rec, term, nil
}
