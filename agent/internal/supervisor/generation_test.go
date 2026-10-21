package supervisor

import (
	"encoding/json"
	"homelab/agent/internal/protocol"
	"strings"
	"testing"
)

func TestInnerOperationGenerationDecodedHashedAndPinned(t *testing.T) {
	var request protocol.Request
	if e := json.NewDecoder(strings.NewReader(`{"machine_identity_generation":"installed"}`)).Decode(&request); e != nil {
		t.Fatal(e)
	}
	s := Service{Config: Config{MachineIdentityGeneration: "installed"}}
	if e := s.validateInstallationGeneration(request.MachineIdentityGeneration); e != nil {
		t.Fatal(e)
	}
	h, e := protocol.Hash(request)
	if e != nil {
		t.Fatal(e)
	}
	request.MachineIdentityGeneration = "replacement"
	next, _ := protocol.Hash(request)
	if next == h {
		t.Fatal("generationexcludedfromsemantichash")
	}
	if s.validateInstallationGeneration(request.MachineIdentityGeneration) == nil {
		t.Fatal("replacementaccepted")
	}
	if s.validateInstallationGeneration("") == nil {
		t.Fatal("generationomissionaccepted")
	}
}
