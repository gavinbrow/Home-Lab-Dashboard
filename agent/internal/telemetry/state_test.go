package telemetry

import (
	"path/filepath"
	"testing"
)

func TestTelemetrySequenceSurvivesRestart(t *testing.T) {
	p := filepath.Join(t.TempDir(), "telemetry.db")
	s, e := OpenSequence(p)
	if e != nil {
		t.Fatal(e)
	}
	n, e := s.Next()
	if e != nil || n != 1 {
		t.Fatal(n, e)
	}
	s.Close()
	s, e = OpenSequence(p)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	n, e = s.Next()
	if e != nil || n != 2 {
		t.Fatal(n, e)
	}
}
