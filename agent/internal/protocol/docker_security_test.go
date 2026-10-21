package protocol

import "testing"

func TestDockerNoNewPrivilegesRequiresOneExactEnabledOption(t *testing.T) {
	for _, options := range [][]string{{"no-new-privileges"}, {"no-new-privileges:true"}, {"no-new-privileges=true"}, {"seccomp=default", "no-new-privileges:true", "apparmor=default"}} {
		if !DockerNoNewPrivilegesEnabled(options) {
			t.Fatal("documented enabled form rejected")
		}
	}
	for _, options := range [][]string{nil, {}, {"no-new-privileges:false"}, {"no-new-privileges=false"}, {"no-new-privileges=1"}, {"no-new-privileges=TRUE"}, {"no-new-privileges:false", "no-new-privileges:true"}, {"no-new-privileges:true", "no-new-privileges:false"}, {"no-new-privileges", "no-new-privileges:true"}, {"no-new-privileges:"}, {"no-new-privileges:true:extra"}, {"no-new-privilegesExtra"}, {" no-new-privileges:true"}, {"NO-NEW-PRIVILEGES:TRUE"}} {
		if DockerNoNewPrivilegesEnabled(options) {
			t.Fatal("missing, disabled or ambiguous isolation proof accepted")
		}
	}
}
