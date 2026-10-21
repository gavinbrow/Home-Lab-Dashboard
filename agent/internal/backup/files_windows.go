package backup

import (
	"os"
	"syscall"
)

func openRegular(root *os.Root, p string) (*os.File, error) { return root.Open(p) }
func isLink(info os.FileInfo) bool {
	if info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	if data, ok := info.Sys().(*syscall.Win32FileAttributeData); ok {
		return data.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0
	}
	return false
}
