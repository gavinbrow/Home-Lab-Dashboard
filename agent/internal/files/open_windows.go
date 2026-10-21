package files

import (
	"os"
	"syscall"
)

func openRead(root *os.Root, p string) (*os.File, error) { return root.Open(p) }
func isReparse(info os.FileInfo) bool {
	if data, ok := info.Sys().(*syscall.Win32FileAttributeData); ok && data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return true
	}
	return info.Mode()&os.ModeSymlink != 0
}
