//go:build windows

package terminal

import "errors"

func newContainerBackend(c ContainerConfig) (backend, error) {
	return nil, errors.New("linux_container_terminal_requires_enrolled_linux_systemd_runtime")
}
func RunContainerStopHelper(statePath string) error {
	return errors.New("container_stop_helper_requires_enrolled_linux_runtime")
}
