//go:build windows

package native

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type process struct {
	job, handle windows.Handle
	created     uint64
	sid         string
	code        uint32
	done        bool
	pid         uint32
	invocation  string
	spooled     chan struct{}
}
type Runner struct {
	config    Config
	mu        sync.Mutex
	processes map[string]*process
}

var logonUser = windows.NewLazySystemDLL("advapi32.dll").NewProc("LogonUserW")
var isInJob = windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob")

func New(c Config) (*Runner, error) {
	if e := validateConfig(c); e != nil {
		return nil, e
	}
	if c.Account == "" || c.Domain == "" || c.ExpectedSID == "" || !filepath.IsAbs(c.PasswordFile) {
		return nil, errors.New("explicit_restricted_account_credentials_required")
	}
	if _, e := windows.StringToSid(c.ExpectedSID); e != nil {
		return nil, errors.New("invalid_expected_execution_sid")
	}
	current, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		return nil, e
	}
	if current.User.Sid.String() == c.ExpectedSID {
		return nil, errors.New("dedicated_account_must_differ_from_supervisor")
	}
	return &Runner{config: c, processes: map[string]*process{}}, nil
}
func (r *Runner) Validate(s Spec) error {
	if e := validate(r.config, s); e != nil {
		return e
	}
	if s.NetworkPolicy != "unrestricted" {
		return errors.New("windows_native_restrictive_network_policy_unsupported")
	}
	return nil
}
func (r *Runner) token() (windows.Token, error) {
	b, e := os.ReadFile(r.config.PasswordFile)
	if e != nil {
		return 0, errors.New("execution_credential_unavailable")
	}
	defer func() {
		for i := range b {
			b[i] = 0
		}
	}()
	// Password bytes are exact UTF-8, without an implicit trim/newline convention.
	if len(b) == 0 || len(b) > 4096 {
		return 0, errors.New("invalid_execution_credential")
	}
	password, e := windows.UTF16FromString(string(b))
	if e != nil {
		return 0, e
	}
	defer func() {
		for i := range password {
			password[i] = 0
		}
	}()
	account, e := windows.UTF16PtrFromString(r.config.Account)
	if e != nil {
		return 0, e
	}
	domain, e := windows.UTF16PtrFromString(r.config.Domain)
	if e != nil {
		return 0, e
	}
	var token windows.Token
	ok, _, callErr := logonUser.Call(uintptr(unsafe.Pointer(account)), uintptr(unsafe.Pointer(domain)), uintptr(unsafe.Pointer(&password[0])), 4, 0, uintptr(unsafe.Pointer(&token))) // LOGON32_LOGON_BATCH
	if ok == 0 {
		return 0, errors.New("restricted_account_batch_logon_failed: " + callErr.Error())
	}
	if e = verifyToken(token, r.config.ExpectedSID); e != nil {
		token.Close()
		return 0, e
	}
	return token, nil
}
func verifyToken(t windows.Token, expected string) error {
	u, e := t.GetTokenUser()
	if e != nil {
		return e
	}
	if u.User.Sid.String() != expected {
		return errors.New("execution_sid_mismatch")
	}
	groups, e := t.GetTokenGroups()
	if e != nil {
		return e
	}
	// Reject administrators even when UAC marks the administrator group deny-only;
	// a reviewed ACL must never depend on an administrator's filtered token.
	for _, g := range groups.AllGroups() {
		sid := g.Sid.String()
		if sid == "S-1-5-32-544" || sid == "S-1-5-32-547" || sid == "S-1-5-32-551" || sid == "S-1-5-32-548" || strings.HasSuffix(sid, "-512") || strings.HasSuffix(sid, "-519") {
			return errors.New("privileged_execution_account_rejected")
		}
	}
	if t.IsElevated() {
		return errors.New("elevated_execution_token_rejected")
	}
	var size uint32
	windows.GetTokenInformation(t, windows.TokenPrivileges, nil, 0, &size)
	if size < 4 || size > 65536 {
		return errors.New("execution_privileges_unverified")
	}
	buffer := make([]byte, size)
	if e = windows.GetTokenInformation(t, windows.TokenPrivileges, &buffer[0], size, &size); e != nil {
		return e
	}
	privileges := (*windows.Tokenprivileges)(unsafe.Pointer(&buffer[0]))
	allowed := map[windows.LUID]bool{}
	for _, name := range []string{"SeChangeNotifyPrivilege", "SeIncreaseWorkingSetPrivilege", "SeTimeZonePrivilege"} {
		ptr, _ := windows.UTF16PtrFromString(name)
		var luid windows.LUID
		if e = windows.LookupPrivilegeValue(nil, ptr, &luid); e != nil {
			return e
		}
		allowed[luid] = true
	}
	for _, priv := range privileges.AllPrivileges() {
		if !allowed[priv.Luid] {
			return errors.New("execution_account_privilege_rejected")
		}
	}
	return nil
}
func processCreation(h windows.Handle) (uint64, error) {
	var c, x, k, u windows.Filetime
	e := windows.GetProcessTimes(h, &c, &x, &k, &u)
	return uint64(c.HighDateTime)<<32 | uint64(c.LowDateTime), e
}
func (r *Runner) Launch(ctx context.Context, s Spec) (Record, error) {
	return r.launch(ctx, s, nil)
}
func (r *Runner) launch(ctx context.Context, s Spec, console *windowsTerminal) (Record, error) {
	if e := ctx.Err(); e != nil {
		return Record{}, e
	}
	if e := r.Validate(s); e != nil {
		return Record{}, e
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.processes[s.ID]; ok {
		return Record{}, errors.New("native_duplicate_launch")
	}
	t, e := r.token()
	if e != nil {
		return Record{}, e
	}
	defer t.Close()
	rec := Record{ID: s.ID, ContainerID: "Local\\Homelab-" + s.ID, Identity: r.config.ExpectedSID, OutputPath: filepath.Join(r.config.SpoolDir, s.ID+".log"), Deadline: time.Now().Add(time.Duration(s.Limits.TimeoutSeconds) * time.Second)}
	output, e := os.OpenFile(rec.OutputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return Record{}, e
	}
	// Job DACL excludes the restricted account so commands cannot change limits.
	current, e := windows.GetCurrentProcessToken().GetTokenUser()
	if e != nil {
		output.Close()
		return Record{}, e
	}
	sd, e := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + current.User.Sid.String() + ")")
	if e != nil {
		output.Close()
		return Record{}, e
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	name, _ := windows.UTF16PtrFromString(rec.ContainerID)
	job, e := windows.CreateJobObject(&sa, name)
	if e != nil {
		output.Close()
		return Record{}, e
	}
	failed := true
	defer func() {
		if failed {
			windows.TerminateJobObject(job, 1)
			windows.CloseHandle(job)
			output.Close()
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS | windows.JOB_OBJECT_LIMIT_JOB_MEMORY
	limits.BasicLimitInformation.ActiveProcessLimit = uint32(s.Limits.Pids)
	limits.JobMemoryLimit = uintptr(s.Limits.MemoryBytes)
	if _, e = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); e != nil {
		return Record{}, e
	}
	cpu := struct{ Flags, Rate uint32 }{5, uint32(s.Limits.CPUPercent * 100)} // ENABLE | HARD_CAP
	if _, e = windows.SetInformationJobObject(job, windows.JobObjectCpuRateControlInformation, uintptr(unsafe.Pointer(&cpu)), uint32(unsafe.Sizeof(cpu))); e != nil {
		return Record{}, e
	}
	attrs, e := windows.NewProcThreadAttributeList(1)
	if e != nil {
		return Record{}, e
	}
	defer attrs.Delete()
	startup := windows.StartupInfoEx{}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.ProcThreadAttributeList = attrs.List()
	var reader *os.File
	inherit := false
	flags := uint32(windows.CREATE_SUSPENDED | windows.CREATE_UNICODE_ENVIRONMENT | windows.EXTENDED_STARTUPINFO_PRESENT)
	if console == nil {
		var read, write windows.Handle
		pipeSA := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
		if e = windows.CreatePipe(&read, &write, &pipeSA, 0); e != nil {
			return Record{}, e
		}
		defer windows.CloseHandle(write)
		windows.SetHandleInformation(read, windows.HANDLE_FLAG_INHERIT, 0)
		reader = os.NewFile(uintptr(read), "native-output")
		defer func() {
			if failed {
				reader.Close()
			}
		}()
		// STARTUPINFOEX handle list prevents leaking other supervisor handles when
		// bInheritHandles is true. Only stdout/stderr and a read-only NUL input pass.
		nul, _ := windows.UTF16PtrFromString("NUL")
		input, e := windows.CreateFile(nul, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, &pipeSA, windows.OPEN_EXISTING, 0, 0)
		if e != nil {
			return Record{}, e
		}
		defer windows.CloseHandle(input)
		handles := []windows.Handle{write, input}
		if e = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])); e != nil {
			return Record{}, e
		}
		startup.Flags = windows.STARTF_USESTDHANDLES
		startup.StdOutput = write
		startup.StdErr = write
		startup.StdInput = input
		inherit = true
		flags |= windows.CREATE_NO_WINDOW
	} else {
		// PSEUDOCONSOLE's lpValue is HPCON itself, unlike attributes that point to
		// a buffer. Pass its integer handle directly through the Win32 ABI.
		update := windows.NewLazySystemDLL("kernel32.dll").NewProc("UpdateProcThreadAttribute")
		ok, _, callErr := update.Call(uintptr(unsafe.Pointer(attrs.List())), 0, windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, uintptr(console.handle), unsafe.Sizeof(console.handle), 0, 0)
		if ok == 0 {
			return Record{}, callErr
		}
	}
	args := []string{syscall.EscapeArg(s.Command)}
	for _, a := range s.Args {
		args = append(args, syscall.EscapeArg(a))
	}
	app, e := windows.UTF16PtrFromString(s.Command)
	if e != nil {
		return Record{}, e
	}
	command, e := windows.UTF16PtrFromString(strings.Join(args, " "))
	if e != nil {
		return Record{}, e
	}
	cwd, e := windows.UTF16PtrFromString(s.Cwd)
	if e != nil {
		return Record{}, e
	}
	var env *uint16
	if e = windows.CreateEnvironmentBlock(&env, t, false); e != nil {
		return Record{}, e
	}
	defer windows.DestroyEnvironmentBlock(env)
	var pi windows.ProcessInformation
	if e = windows.CreateProcessAsUser(t, app, command, nil, nil, inherit, flags, env, cwd, &startup.StartupInfo, &pi); e != nil {
		return Record{}, e
	}
	defer windows.CloseHandle(pi.Thread)
	// Every failure before ResumeThread terminates the suspended child; there is
	// no fallback launch under the supervisor or current user's identity.
	childFailed := true
	defer func() {
		if childFailed {
			windows.TerminateProcess(pi.Process, 1)
			windows.CloseHandle(pi.Process)
		}
	}()
	var childToken windows.Token
	if e = windows.OpenProcessToken(pi.Process, windows.TOKEN_QUERY, &childToken); e != nil {
		return Record{}, e
	}
	e = verifyToken(childToken, rec.Identity)
	childToken.Close()
	if e != nil {
		return Record{}, e
	}
	if e = windows.AssignProcessToJobObject(job, pi.Process); e != nil {
		return Record{}, e
	}
	var member uint32
	ok, _, callErr := isInJob.Call(uintptr(pi.Process), uintptr(job), uintptr(unsafe.Pointer(&member)))
	if ok == 0 || member == 0 {
		return Record{}, errors.New("job_membership_unverified: " + callErr.Error())
	}
	rec.PID = pi.ProcessId
	rec.CreatedAt, e = processCreation(pi.Process)
	if e != nil {
		return Record{}, e
	}
	rec.InvocationID = rec.ContainerID + ":" + time.Now().UTC().Format(time.RFC3339Nano)
	if _, e = windows.ResumeThread(pi.Thread); e != nil {
		return Record{}, e
	}
	p := &process{job: job, handle: pi.Process, created: rec.CreatedAt, sid: rec.Identity, pid: rec.PID, invocation: rec.InvocationID, spooled: make(chan struct{})}
	r.processes[s.ID] = p
	failed = false
	childFailed = false
	if console == nil {
		go func() { spool(reader, output, s.Limits.MaxOutputBytes); close(p.spooled) }()
	} else {
		output.Close()
		close(p.spooled)
	}
	go r.watch(s.ID, p, time.Until(rec.Deadline))
	return rec, nil
}
func spool(reader, output *os.File, max int64) {
	defer reader.Close()
	defer output.Close()
	io.CopyN(output, reader, max)
	io.Copy(io.Discard, reader)
	output.Sync()
}
func (r *Runner) watch(id string, p *process, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		expired := false
		select {
		case <-timer.C:
			expired = true
		case <-ticker.C:
		}
		r.mu.Lock()
		if expired {
			windows.TerminateJobObject(p.job, 1460)
		}
		var basic struct {
			Times                             [4]int64
			Faults, Total, Active, Terminated uint32
		}
		e := windows.QueryInformationJobObject(p.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic)), nil)
		if e == nil && basic.Active == 0 {
			var code uint32
			if windows.GetExitCodeProcess(p.handle, &code) == nil {
				p.done = true
				p.code = code
				windows.CloseHandle(p.handle)
				windows.CloseHandle(p.job)
				r.mu.Unlock()
				return
			}
		}
		r.mu.Unlock()
	}
}
func (r *Runner) Inspect(ctx context.Context, rec Record) (Status, error) {
	if e := ctx.Err(); e != nil {
		return Status{}, e
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	p, ok := r.processes[rec.ID]
	if !ok {
		return Status{}, ErrUnknown
	} // restart: kill-on-close, never PID-only reattach
	if rec.Identity != p.sid || rec.Identity != r.config.ExpectedSID || rec.CreatedAt != p.created || rec.ContainerID != "Local\\Homelab-"+rec.ID || rec.PID != p.pid || rec.InvocationID != p.invocation {
		return Status{}, ErrUnknown
	}
	if p.done {
		select {
		case <-p.spooled:
		default:
			return Status{Exists: true, Running: true, IdentityVerified: true, Reason: "output_flush_pending"}, nil
		}
		return Status{Exists: true, Running: false, ExitCode: int(p.code), IdentityVerified: true}, nil
	}
	var basic struct {
		TotalUser, TotalKernel, ThisUser, ThisKernel int64
		Faults, Total, Active, Terminated            uint32
	}
	if e := windows.QueryInformationJobObject(p.job, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic)), nil); e != nil {
		return Status{}, e
	}
	var code uint32
	if e := windows.GetExitCodeProcess(p.handle, &code); e != nil {
		return Status{}, e
	}
	running := basic.Active > 0
	if !running {
		select {
		case <-p.spooled:
		default:
			running = true
		}
	}
	return Status{Exists: true, Running: running, ExitCode: int(code), IdentityVerified: true}, nil
}
func (r *Runner) Cancel(ctx context.Context, rec Record) error {
	if _, e := r.Inspect(ctx, rec); e != nil {
		return e
	}
	r.mu.Lock()
	p := r.processes[rec.ID]
	if p.done {
		r.mu.Unlock()
		return nil
	}
	e := windows.TerminateJobObject(p.job, 1223)
	r.mu.Unlock()
	if e != nil {
		return e
	}
	// Confirmation is deliberately separate from the termination request.
	s, e := r.Inspect(ctx, rec)
	if e != nil {
		return e
	}
	if s.Running {
		return errors.New("native_cancellation_pending")
	}
	return nil
}
