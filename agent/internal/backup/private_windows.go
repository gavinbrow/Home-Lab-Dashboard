package backup

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"unsafe"
)

func privateDirectory(p string, newOnly bool) error {
	user, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		return e
	}
	sid := user.User.Sid.String()
	e = os.Mkdir(p, 0700)
	created := e == nil
	if e != nil && (!os.IsExist(e) || newOnly) {
		return e
	}
	if created {
		sd, e := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;" + sid + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
		if e != nil {
			return e
		}
		acl, _, e := sd.DACL()
		if e != nil {
			return e
		}
		if e = windows.SetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil); e != nil {
			return e
		}
	}
	info, e := os.Lstat(p)
	if e != nil || !info.IsDir() || isLink(info) {
		return errors.New("backup_private_directory_required")
	}
	sd, e := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if e != nil {
		return e
	}
	owner, _, e := sd.Owner()
	if e != nil {
		return e
	}
	if owner.String() != sid && owner.String() != "S-1-5-18" && owner.String() != "S-1-5-32-544" {
		return errors.New("backup_private_directory_owner_invalid")
	}
	ctl, _, e := sd.Control()
	if e != nil || ctl&windows.SE_DACL_PROTECTED == 0 {
		return errors.New("backup_private_directory_protected_dacl_required")
	}
	acl, _, e := sd.DACL()
	if e != nil || acl == nil {
		return errors.New("backup_private_directory_dacl_required")
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if e = windows.GetAce(acl, i, &ace); e != nil {
			return e
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("backup_private_directory_unknown_ace")
		}
		s := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if s != sid && s != "S-1-5-18" && s != "S-1-5-32-544" {
			return errors.New("backup_private_directory_acl_too_broad")
		}
	}
	return nil
}
