package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"homelab/agent/internal/protocol"
	"testing"
)

func TestRPCInstallationGenerationIsSignedAndPinned(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	v := RPCVerifier{KeyID: "key", PublicKey: pub, DispatchEpoch: "epoch", MachineIdentityGeneration: "installed"}
	r := RPCRequest{DispatchEpoch: "epoch", MachineIdentityGeneration: "installed"}
	raw, _ := protocol.CanonicalJSON(r)
	r.Authorization = &RPCAuthorization{KeyID: "key", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, raw))}
	if e := v.Verify(r); e != nil {
		t.Fatal(e)
	}
	r.MachineIdentityGeneration = "replacement"
	if v.Verify(r) == nil {
		t.Fatal("replacementgenerationaccepted")
	}
	r.MachineIdentityGeneration = ""
	if v.Verify(r) == nil {
		t.Fatal("generationomissionaccepted")
	}
	r.MachineIdentityGeneration = "installed"
	v.MachineIdentityGeneration = ""
	if v.Verify(r) == nil {
		t.Fatal("unconfiguredinstallationadoptedgeneration")
	}
}
