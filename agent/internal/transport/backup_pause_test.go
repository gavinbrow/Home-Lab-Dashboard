package transport

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestConnectionBackupCutPausesOnlyAtSafeBoundary(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	loopDone := make(chan error, 1)
	entered := make(chan struct{})
	go func() {
		for {
			if _, e := os.Stat(filepath.Join(dir, "backup-pause.json")); e == nil {
				close(entered)
				loopDone <- connectionBackupBoundary(ctx, dir)
				return
			}
			select {
			case <-ctx.Done():
				loopDone <- ctx.Err()
				return
			case <-time.After(time.Millisecond):
			}
		}
	}()
	cut := false
	if e := WithConnectionPaused(ctx, dir, time.Second, func() error {
		<-entered
		select {
		case <-loopDone:
			t.Fatal("connection resumed inside cut")
		default:
		}
		cut = true
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if !cut {
		t.Fatal("cut absent")
	}
	if e := <-loopDone; e != nil {
		t.Fatal(e)
	}
	if _, e := os.Stat(filepath.Join(dir, "backup-pause.json")); !os.IsNotExist(e) {
		t.Fatal("lease not removed")
	}
}
