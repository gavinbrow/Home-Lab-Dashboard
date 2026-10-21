# Native execution prerequisites and verification

This package provides OS account execution and descendant containment. It does
not create accounts, change security policy, or install a service. Native execution
must remain disabled until an operator provisions an existing dedicated account,
reviews its actual filesystem permissions and rights, and passes the disposable
tests below. `acl_reviewed` records that enrollment decision; it is not an ACL
scanner or proof that Windows/Linux permissions are correct.

After the account review, invoke the authenticated supervisor
`POST /v1/identities/{id}/verify` onboarding action. It uses the fixed trusted
agent executable and a nonsecret denied sentinel in protected spool; network
clients cannot supply a command or path. The actual restricted-account probe must
verify its observed UID/SID, create/remove its own files in project and scratch,
and fail to read the sentinel or write its parent. GET identity results report
verified only while a protected proof matches the supervisor configuration,
the current supervisor process, and its five-minute freshness window. A separate
CLI process cannot transfer a valid proof into the supervisor. Restart/config
changes require verification again. These concrete checks supplement the manual
ACL/rights review; they do not scan every system path or privilege.

The supervisor must run independently of the network agent. Launch is called only
after the supervisor journals `launching`. A launch error can mean the OS accepted
the command; do not call Launch again. Store Record in the supervisor journal,
then use Inspect/Cancel. A lost Record means outcome unknown. Logs never authorize
reattachment. Record contains the OS invocation/creation identity, not only a PID.

## Linux

Use a Linux host with a system systemd manager supporting `ExitType=cgroup`
(systemd 250 or newer), cgroup CPU/memory/pids controllers, and service-manager
permission to create/stop transient units. Provision a non-root per-project
UID/GID that differs from the supervisor, has no extra supplementary groups, and
can access only its project and designated scratch plus required runtime reads.
Use an existing account; numeric UID/GID must resolve through the host account
database. Root and scratch must be canonical existing paths outside hidden home
directories (for example under `/srv`). Configure `/usr/bin/systemd-run` and
`/usr/bin/systemctl` explicitly.

Provision a separate spool directory owned by the supervisor with mode 0700.
Neither the execution account nor project writers may modify the spool or its
ancestors. Do not place spool, supervisor configuration, service credentials, or
executables in project/scratch. Keep approved-root ancestors and installed system
executables protected from the execution account. Review existing Unix socket
permissions too: an account allowed to access Docker or a privileged management
socket is not restricted.

Each operation owns a named transient service with numeric User/Group,
NoNewPrivileges, no capabilities, strict read-only system mounts, exact writable
project/scratch, hidden home directories, private devices/tmp, cgroup descendant
lifetime and cancellation, and kernel runtime/CPU/memory/tasks limits. The service
survives agent/network/supervisor disconnection until completion/deadline. Linux
`none` networking uses a private network namespace; `unrestricted` deliberately
uses host networking. Network allowlists are rejected. This does not prevent Unix
socket side effects permitted by filesystem permissions.

`LimitFSIZE` bounds spool disk usage and **also caps each regular file produced by
the command** at MaxOutputBytes; exceeding it can terminate a writer with SIGXFSZ.
Document this additional native policy in enrollment. `$` and `%` in Linux command
arguments are rejected to avoid systemd environment/specifier expansion changing
the requested command. Use a reviewed executable/script file when such syntax is
required. Unit names cannot be reused; finished units remain available for
reconciliation. Explicitly clean old units only after journal retention/export.

## Windows

Provision an existing dedicated per-project account with reviewed NTFS ACLs and
batch logon right. The supervisor service identity needs the documented
CreateProcessAsUser rights (typically SeIncreaseQuotaPrivilege and potentially
SeAssignPrimaryTokenPrivilege). Configure Account, Domain, ExpectedSID and a
protected PasswordFile containing exact UTF-8 password bytes, without a newline.
Keep the password/config/spool paths outside project and scratch, with ACLs
limited to the supervisor/service administrators. The account must not belong to
Administrators, Power Users, Backup Operators, Account Operators, domain admins,
or enterprise admins. Remove elevated user-right assignments: only
SeChangeNotifyPrivilege, SeIncreaseWorkingSetPrivilege and SeTimeZonePrivilege
are accepted in the resulting token, including disabled privileges. The launcher
verifies the LogonUser token and the actual suspended child's token against the
configured SID before executing project code. There is no current-user fallback.

Grant only needed runtime reads and project/scratch writes. Deny unrelated user
data and other projects according to the intended policy; account separation
does not itself remove default Users read permissions. Review execution-account
access to scheduled tasks, service creation, WMI, named pipes and management
endpoints. Job Objects group ordinary descendant processes; they cannot contain
processes created indirectly through an external privileged service.

CreateProcessAsUser creates the child suspended. The launcher assigns it to a
protected named Job Object, verifies membership, then resumes it. Breakaway is
not permitted. Only explicit stdio handles are inherited. Job Objects enforce
CPU/memory/process limits; an independent supervisor timer enforces wall time.
Output is drained into a bounded protected spool. Cancellation force-terminates
the Job Object; arbitrary Windows commands have no universal graceful-stop
protocol. Confirmation waits for zero active job members and final output flush.
Supervisor termination closes the last job handle and kills its members. A new
supervisor reports unknown/interrupted and never reattaches by PID; seamless
supervisor restart recovery is not claimed. Restarting the separate connection
agent does not affect the supervisor's handles or timers.

Windows native execution currently supports only explicit `unrestricted`
networking. `none` and allowlists fail before token logon/process creation because
no tested WFP/firewall integration is implemented. Select the Linux isolated
runtime for restrictive networking.

## Required disposable runtime tests

Local unit tests prove negative validation, forged-log-path rejection, output
bounds and restart uncertainty. Cross-compilation proves only buildability.
Before enabling native execution on a host, record host/OS/version, configured
UID/GID or SID, account group/rights review, and test workspace file hashes.
Execute harmless identity commands and verify actual UID/groups or `whoami /all`;
verify intended reads/writes work and unrelated project/user access and privileged
actions fail. Run a bounded parent/child fixture, cancel it, and independently
check that descendants ended. Exercise short time/CPU/memory/process/output
limits. Disconnect the connection agent and browser during a timed command;
Linux service/Windows supervisor deadlines must remain effective. Kill only the
disposable supervisor instance and verify the documented platform recovery result
and absence of command replay. On Linux inspect surviving systemd invocation IDs;
on Windows confirm kill-on-close. Verify restrictive network policy enforcement
or rejection. Credentials or provisioning absent means these tests are blocked,
never passed. Do not run these tests against unrelated user processes/services.

Platform references: [CreateProcessAsUser](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw),
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[systemd execution](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html),
[systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).
