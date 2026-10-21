package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

type backupPause struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expires_at"`
}

// WithConnectionPaused asks the protected outbound loop to stop all collection,
// rotation, spool delivery and polling at its next safe boundary. No DB mutex is
// held while waiting. A bounded lease prevents an abandoned export pausing forever.
func WithConnectionPaused(ctx context.Context, dir string, duration time.Duration, fn func() error) error {
	var nonce [16]byte
	if _, e := rand.Read(nonce[:]); e != nil {
		return e
	}
	q := backupPause{hex.EncodeToString(nonce[:]), time.Now().Add(duration + 2*time.Minute)}
	request := filepath.Join(dir, "backup-pause.json")
	ack := filepath.Join(dir, "backup-pause-ack.json")
	temporary := request + "." + q.ID + ".tmp"
	f, e := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return errors.New("connection_backup_pause_busy")
	}
	defer os.Remove(temporary)
	raw, _ := json.Marshal(q)
	_, e = f.Write(raw)
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	if e == nil {
		e = os.Link(temporary, request)
	}
	if e != nil {
		return e
	}
	defer os.Remove(request)
	defer os.Remove(ack)
	if e != nil {
		return e
	}
	deadline := time.NewTimer(120 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		b, e := os.ReadFile(ack)
		var a backupPause
		if e == nil && json.Unmarshal(b, &a) == nil && a.ID == q.ID {
			return fn()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("connection_backup_pause_unconfirmed")
		case <-tick.C:
		}
	}
}
func connectionBackupBoundary(ctx context.Context, dir string) error {
	request := filepath.Join(dir, "backup-pause.json")
	b, e := os.ReadFile(request)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	var q backupPause
	if json.Unmarshal(b, &q) != nil || q.ID == "" || time.Until(q.ExpiresAt) > 26*time.Hour {
		return errors.New("invalid_connection_backup_pause")
	}
	if !q.ExpiresAt.After(time.Now()) {
		return nil
	}
	ack := filepath.Join(dir, "backup-pause-ack.json")
	if e = os.WriteFile(ack, b, 0600); e != nil {
		return e
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		b, e := os.ReadFile(request)
		var next backupPause
		if errors.Is(e, os.ErrNotExist) || !q.ExpiresAt.After(time.Now()) {
			return nil
		}
		if e != nil {
			return e
		}
		if json.Unmarshal(b, &next) != nil || next.ID != q.ID {
			return errors.New("connection_backup_pause_changed")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}
