package backup

import (
	"errors"
	"os"
	"syscall"
)

func privateDirectory(p string, newOnly bool) error {
	e := os.Mkdir(p, 0700)
	if e != nil && (!os.IsExist(e) || newOnly) {
		return e
	}
	info, e := os.Lstat(p)
	if e != nil {
		return e
	}
	s, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || s.Uid != uint32(os.Geteuid()) || info.Mode().Perm()&0077 != 0 {
		return errors.New("backup_private_directory_required")
	}
	return nil
}
