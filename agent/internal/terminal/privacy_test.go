package terminal

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTranscriptRequiresProtectedAndSessionOptIn(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		configured, requested bool
	}{{"neither", false, false}, {"session-only", false, true}, {"config-only", true, false}, {"both", true, true}} {
		t.Run(tc.name, func(t *testing.T) {
			c, b, _, _ := fixture(t)
			c.RecordTranscript = tc.configured
			m, e := newManager(c, b)
			if e != nil {
				t.Fatal(e)
			}
			defer m.Close()
			spec := request(t, "privacy-session")
			spec.RetainOutput = tc.requested
			rec, e := m.Start(context.Background(), spec)
			if e != nil {
				t.Fatal(e)
			}
			if rec.RetainOutput != tc.requested {
				t.Fatal("retention snapshot lost")
			}
			if _, e = b.console.writer.Write([]byte("test transcript")); e != nil {
				t.Fatal(e)
			}
			deadline := time.Now().Add(time.Second)
			for m.record(rec.ID).OutputOffset < 15 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			if _, e = m.Cancel(context.Background(), rec.ID); e != nil {
				t.Fatal(e)
			}
			data, e := os.ReadFile(filepath.Join(c.DataDir, rec.ID+".transcript"))
			if tc.configured && tc.requested {
				if e != nil || string(data) != "test transcript" {
					t.Fatalf("explicit recording missing: %q %v", data, e)
				}
			} else if !os.IsNotExist(e) {
				t.Fatal("raw transcript persisted despite session/config optout", e)
			}
		})
	}
}
func TestReplayCannotChangeCapturedRetention(t *testing.T) {
	c, b, _, _ := fixture(t)
	c.RecordTranscript = true
	m, e := newManager(c, b)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	spec := request(t, "retention-conflict")
	if _, e = m.Start(context.Background(), spec); e != nil {
		t.Fatal(e)
	}
	spec.RetainOutput = true
	if _, e = m.Start(context.Background(), spec); e == nil {
		t.Fatal("stable ID accepted changed recording policy")
	}
	if b.launches != 1 {
		t.Fatal("recording change relaunched process")
	}
}
