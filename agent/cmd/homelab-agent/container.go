package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"
)

type exitStatusError struct{ Code int }

func (e exitStatusError) Error() string { return fmt.Sprintf("process_exit_%d", e.Code) }

type encodedOutput struct {
	mu        sync.Mutex
	writer    io.Writer
	pending   []byte
	remaining int64
	truncated bool
	err       error
}

func (w *encodedOutput) flushLocked() {
	if len(w.pending) == 0 || w.err != nil {
		return
	}
	w.err = json.NewEncoder(w.writer).Encode(map[string]any{"homelab_log": 1, "data": base64.StdEncoding.EncodeToString(w.pending)})
	w.pending = w.pending[:0]
}
func (w *encodedOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	accepted := min(int64(n), w.remaining)
	w.remaining -= accepted
	for len(p) > 0 && accepted > 0 {
		count := min(int(accepted), 16384-len(w.pending))
		w.pending = append(w.pending, p[:count]...)
		p = p[count:]
		accepted -= int64(count)
		if len(w.pending) == 16384 {
			w.flushLocked()
		}
	}
	if len(p) > 0 && !w.truncated {
		w.flushLocked()
		w.truncated = true
		if w.err == nil {
			w.err = json.NewEncoder(w.writer).Encode(map[string]any{"homelab_log": 1, "truncated": true})
		}
	}
	return n, w.err
}
func (w *encodedOutput) Flush() { w.mu.Lock(); defer w.mu.Unlock(); w.flushLocked() }
func containerRun(args []string) error {
	fs := flag.NewFlagSet("container-run", flag.ContinueOnError)
	timeout := fs.Int("timeout", 0, "")
	max := fs.Int64("max-output", 0, "")
	if e := fs.Parse(args); e != nil {
		return e
	}
	argv := fs.Args()
	if *timeout < 1 || *timeout > 3600 || *max < 1 || *max > 1<<30 || len(argv) == 0 {
		return errors.New("invalid_container_helper_limits")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeout)*time.Second)
	defer cancel()
	out := &encodedOutput{writer: os.Stdout, remaining: *max}
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				out.Flush()
			case <-done:
				return
			}
		}
	}()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.WaitDelay = 2 * time.Second
	e := cmd.Run()
	close(done)
	out.Flush()
	if ctx.Err() != nil {
		return exitStatusError{124}
	}
	if e != nil {
		var exit *exec.ExitError
		if errors.As(e, &exit) {
			code := exit.ExitCode()
			if code < 1 {
				code = 1
			}
			return exitStatusError{code}
		}
		return exitStatusError{127}
	}
	return nil
}
