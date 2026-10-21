//go:build windows

package terminal

// Each protected record is file-synced then atomically replaced. Windows does
// not support os.File.Sync on directory handles opened by os.Open.
func syncDirectory(path string) error { return nil }
