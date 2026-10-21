package terminal

// ContainerConfig is protected enrollment policy for a dedicated environment.
// Ending its console stops that entire environment to prove descendant cleanup.
type ContainerConfig struct {
	DockerPath    string  `json:"docker_path"`
	HelperPath    string  `json:"helper_path"`
	SystemdRun    string  `json:"systemd_run"`
	Systemctl     string  `json:"systemctl"`
	RuntimeID     string  `json:"runtime_id"`
	MachineID     string  `json:"machine_id"`
	WorkspaceID   string  `json:"workspace_id"`
	EnvironmentID string  `json:"environment_id"`
	Generation    int     `json:"generation"`
	User          string  `json:"user"`
	Root          string  `json:"root"`
	ImageDigest   string  `json:"image_digest"`
	SpoolDir      string  `json:"spool_dir"`
	IdentityProbe string  `json:"identity_probe"`
	CPUs          float64 `json:"cpus"`
	MemoryBytes   int64   `json:"memory_bytes"`
	PidsLimit     int     `json:"pids_limit"`
}
