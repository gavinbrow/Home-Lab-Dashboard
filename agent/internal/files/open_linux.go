package files

import (
	"os"
	"syscall"
)

func openRead(root *os.Root, p string) (*os.File, error) {
	return root.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
func isReparse(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }
