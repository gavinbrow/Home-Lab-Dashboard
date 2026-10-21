package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestHashExcludesLeaseButIncludesAuthority(t *testing.T) {
	r := Request{SchemaVersion: 1, Command: Command{Executable: "/bin/echo", Args: []string{"<x>\u2028"}, Env: map[string]string{}}, Grant: Grant{Tools: []string{"command"}}}
	h, e := Hash(r)
	if e != nil || len(h) != 64 {
		t.Fatal(h, e)
	}
	r.Fence = 20
	r.DispatchEpoch = "new"
	r.RequestHash = "ignored"
	h2, _ := Hash(r)
	if h != h2 {
		t.Fatal("lease metadata changed semantic hash")
	}
	r.Command.Args[0] = "other"
	h2, _ = Hash(r)
	if h == h2 {
		t.Fatal("command not covered")
	}
}
func TestCanonicalMatchesJSNumericKeysAndUTF16(t *testing.T) {
	raw, e := CanonicalJSON(map[string]any{"10": 10, "2": 2, "0": 0, "z": 1, "\ue000": 1, "\U00010000": 2})
	if e != nil {
		t.Fatal(e)
	}
	expected := "{\"0\":0,\"2\":2,\"10\":10,\"z\":1,\"𐀀\":2,\"\":1}"
	if string(raw) != expected {
		t.Fatalf("got %s", raw)
	}
}

func TestOptionalGrantArraysPreserveAbsentVersusEmpty(t *testing.T) {
	var r Request
	if e := json.Unmarshal([]byte(`{"grant":{"profile_ids":[],"secret_ids":[]}}`), &r); e != nil {
		t.Fatal(e)
	}
	if r.Grant.ProfileIDs == nil || r.Grant.SecretIDs == nil {
		t.Fatal("lost explicitly empty arrays")
	}
	b, e := json.Marshal(r.Grant)
	if e != nil {
		t.Fatal(e)
	}
	var fields map[string]any
	if e = json.Unmarshal(b, &fields); e != nil {
		t.Fatal(e)
	}
	if _, ok := fields["profile_ids"]; !ok {
		t.Fatal("empty optional array omitted from semantic hash")
	}
	emptyHash, _ := Hash(r)
	r.Grant.ProfileIDs = nil
	r.Grant.SecretIDs = nil
	absentHash, _ := Hash(r)
	if emptyHash == absentHash {
		t.Fatal("absent and explicit empty arrays collapsed")
	}
}

func TestGenerationHashMatchesJavaScriptFixture(t *testing.T) {
	raw, e := os.ReadFile("testdata/generation-request.json")
	if e != nil {
		t.Fatal(e)
	}
	var r Request
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if e = decoder.Decode(&r); e != nil {
		t.Fatal(e)
	}
	expected, e := os.ReadFile("testdata/generation-request.sha256")
	if e != nil {
		t.Fatal(e)
	}
	actual, e := Hash(r)
	if e != nil || actual != strings.TrimSpace(string(expected)) {
		t.Fatal("JS/Go request hash mismatch", actual, e)
	}
}

func TestOpaqueLedgerStepIDsPermitColonOnlyForStep(t *testing.T) {
	raw, e := os.ReadFile("testdata/generation-request.json")
	if e != nil {
		t.Fatal(e)
	}
	var r Request
	if e = json.Unmarshal(raw, &r); e != nil {
		t.Fatal(e)
	}
	for _, id := range []string{"command:0", "verification:0123456789abcdef"} {
		r.StepID = id
		r.RequestHash, _ = Hash(r)
		if e = r.Validate(); e != nil {
			t.Fatal(id, e)
		}
	}
	for _, id := range []string{"../x", "a/b", "a\\b", ":bad"} {
		r.StepID = id
		r.RequestHash, _ = Hash(r)
		if r.Validate() == nil {
			t.Fatal("unsafe step accepted", id)
		}
	}
	r.StepID = "command:0"
	r.OperationID = "operation:0"
	r.RequestHash, _ = Hash(r)
	if r.Validate() == nil {
		t.Fatal("colon leaked into filesystem operationID")
	}
}
