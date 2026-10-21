package telemetry

import (
	"testing"
	"time"
)

func TestCounterRateReset(t *testing.T) {
	if Rate(1000, 1, 121*time.Second) != nil {
		t.Fatal("stale collection interval produced current rate")
	}
	if Rate(1, 100, time.Second) != nil {
		t.Fatal("reset produced rate")
	}
	if Rate(100, 1, 0) != nil {
		t.Fatal("zero interval produced rate")
	}
	r := Rate(300, 100, 2*time.Second)
	if r == nil || *r != 100 {
		t.Fatal(r)
	}
}
