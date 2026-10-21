package backup

import (
	"golang.org/x/sys/unix"
	"os"
)

func openRegular(root *os.Root, p string) (*os.File, error) {
	return root.OpenFile(p, os.O_RDONLY|unix.O_NONBLOCK|unix.O_NOFOLLOW, 0)
}
func isLink(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }
