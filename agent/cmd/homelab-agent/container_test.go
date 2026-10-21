package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestContainerLogCapBeforeDaemon(t *testing.T) {
	var output bytes.Buffer
	w := &encodedOutput{writer: &output, remaining: 20}
	for i := 0; i < 1000; i++ {
		if _, e := w.Write([]byte("x")); e != nil {
			t.Fatal(e)
		}
	}
	w.Flush()
	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	var data []byte
	truncations := 0
	for _, line := range lines {
		var message struct {
			Data      string `json:"data"`
			Truncated bool   `json:"truncated"`
		}
		if e := json.Unmarshal([]byte(line), &message); e != nil {
			t.Fatal(e)
		}
		b, e := base64.StdEncoding.DecodeString(message.Data)
		if e != nil {
			t.Fatal(e)
		}
		data = append(data, b...)
		if message.Truncated {
			truncations++
		}
	}
	if len(data) != 20 || truncations != 1 || len(output.Bytes()) > 1024 {
		t.Fatal(len(data), truncations, len(output.Bytes()))
	}
}
