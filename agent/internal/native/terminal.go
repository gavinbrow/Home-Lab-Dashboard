package native

import "io"

// Terminal is the supervisor-owned PTY endpoint. Closing an endpoint alone is
// never evidence that its restricted OS containment and descendants stopped.
type Terminal interface {
	io.ReadWriteCloser
	Resize(cols, rows uint16) error
}
