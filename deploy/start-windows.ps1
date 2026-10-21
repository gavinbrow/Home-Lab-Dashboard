param(
    [string]$Root = $env:HOMELAB_CONTROL_ROOT,
    [string]$Distro = $env:HOMELAB_WSL_DISTRO,
    [string]$Project = $env:HOMELAB_COMPOSE_PROJECT,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
try {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        throw 'WSL is required. Install WSL with a Linux distribution and Docker Engine/Compose; see docs/operations/DEPLOYMENT.md.'
    }
    if (-not $Root) { $Root = '/srv/homelab-control' }
    if (-not $Project) { $Project = 'homelab-control' }
    if (-not $Root.StartsWith('/')) { throw 'Root must be an absolute Linux path in WSL.' }
    if ($Project -cnotmatch '^[a-z0-9][a-z0-9_-]*$') { throw 'Project must be a lowercase Docker Compose project name.' }
    if (-not $Distro) {
        $installed = & wsl.exe --list --quiet
        if ($LASTEXITCODE -ne 0) { throw 'Cannot list WSL distributions. Install/start WSL first.' }
        $candidates = @($installed | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -and $_ -notmatch '^docker-desktop(?:-data)?$' })
        if ($candidates.Count -ne 1) { throw 'Set HOMELAB_WSL_DISTRO (or -Distro) to the Linux distribution containing your deployment. Exactly one non-Docker WSL distribution could not be selected automatically.' }
        $Distro = $candidates[0]
    }

    $wslArgs = @('--distribution', $Distro)
    # The supported installation protects config under Linux root. Containers retain their configured users.
    $wslArgs += @('--user', 'root', '--exec')
    $repo = Split-Path $PSScriptRoot -Parent
    $linuxRepo = & wsl.exe @wslArgs wslpath -a -u $repo
    if ($LASTEXITCODE -ne 0) { throw 'Cannot access the checkout in WSL. Start/install your distribution, or set HOMELAB_WSL_DISTRO to its name.' }
    $linuxRepo = ($linuxRepo -join "`n").Trim()
    if (-not $linuxRepo.StartsWith('/')) { throw 'WSL did not return an absolute checkout path.' }
    if ($Check) {
        & wsl.exe @wslArgs bash --noprofile --norc -n "$linuxRepo/deploy/start.sh"
        if ($LASTEXITCODE -ne 0) { throw 'Linux launcher syntax check failed.' }
        Write-Host 'Launcher syntax/WSL path check passed. No services started; deployment readiness was not checked.'
        exit 0
    }

    Write-Host 'Starting the existing persistent Linux deployment through WSL (root access for protected configuration).'
    $readyUrl = $null
    & wsl.exe @wslArgs bash --noprofile --norc "$linuxRepo/deploy/start.sh" $Root $Project | ForEach-Object {
        if ($_ -match '^HOMELAB_READY_URL=(https://[A-Za-z0-9.-]+)$') { $readyUrl = $Matches[1] }
        else { Write-Host $_ }
    }
    if ($LASTEXITCODE -ne 0) { throw 'Linux startup failed; no successful readiness result was returned.' }
    if (-not $readyUrl) { throw 'Startup did not return a verified dashboard URL.' }
    try {
        $response = Invoke-WebRequest -Uri "$readyUrl/readyz" -UseBasicParsing -TimeoutSec 15
        if ($response.StatusCode -ne 200) { throw 'Unexpected readiness status.' }
    } catch {
        throw "Containers started, but Windows could not verify $readyUrl/readyz over trusted HTTPS. Check hostname resolution, listener/firewall, and install the verified Caddy CA on this Windows account as described in DEPLOYMENT.md. Services remain running; certificate validation was not bypassed."
    }
    Write-Host "Ready: $readyUrl"
    Write-Host 'Use the configured owner login. Your browser must trust the installation CA; never bypass certificate validation.'
    try { Start-Process $readyUrl } catch { Write-Host "Browser could not open automatically. Open $readyUrl manually." }
    exit 0
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
