param(
    [string]$Project = $env:HOMELAB_COMPOSE_PROJECT,
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$NoToken,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
function Docker {
    $ErrorActionPreference = 'Continue'
    & docker.exe --context desktop-linux @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE). Existing volumes/data were preserved." }
}
function DockerProbe {
    $ErrorActionPreference = 'Continue'
    & docker.exe --context desktop-linux @args 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}
function DockerEngineReady {
    $ErrorActionPreference = 'Continue'
    $kind = & docker.exe --context desktop-linux info --format '{{.OSType}}' 2>$null
    return ($LASTEXITCODE -eq 0 -and ($kind -join '').Trim() -eq 'linux')
}
function Compose { Docker compose --project-name $Project -f (Join-Path $PSScriptRoot 'compose.windows.yml') @args }
function Read-LocalDashboardJson([string]$Url, [string]$CertificatePath) {
    $endpoint = [Uri]$Url
    if ($endpoint.Scheme -ne 'https' -or $endpoint.Host -ne 'localhost') { throw 'Dashboard readiness checks require HTTPS localhost.' }
    # The private local CA has no public revocation service. Keep CA/hostname
    # verification; tolerate only unavailable revocation information, not revocation.
    $body = & curl.exe --ssl-revoke-best-effort --cacert $CertificatePath --noproxy '*' --proto '=https' --fail --silent --show-error --connect-timeout 5 --max-time 20 $Url
    if ($LASTEXITCODE -ne 0) { throw "Local HTTPS check failed for $($endpoint.AbsolutePath) (curl exit $LASTEXITCODE). Certificate verification remains enabled." }
    return (($body -join "`n") | ConvertFrom-Json)
}
$launchLock = $null
$ownsLock = $false
try {
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop for Windows, then double-click start.bat again. https://www.docker.com/products/docker-desktop/' }
    if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'Windows curl.exe is required for verified local HTTPS readiness checks. Install current Windows updates, then retry.' }
    if (-not $Project) { $Project = 'homelab-desktop' }
    if ($Project -cnotmatch '^[a-z0-9][a-z0-9_-]{0,62}$') { throw 'Project must contain lowercase letters, numbers, underscores or hyphens.' }
    $launchLock = [Threading.Mutex]::new($false, "Local\HomelabControl-$Project")
    try { $ownsLock = $launchLock.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsLock = $true }
    if (-not $ownsLock) { throw 'Another launcher is already working on this project. Wait for that window to finish.' }
    $localRoot = Join-Path $env:LOCALAPPDATA "HomelabControl\$Project"
    $settingsPath = Join-Path $localRoot 'launcher.json'
    $settings = $null
    if (Test-Path -LiteralPath $settingsPath) {
        $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        if ($Port -and $Port -ne $settings.port) { throw "This installation uses port $($settings.port). Existing settings were not overwritten." }
        $Port = [int]$settings.port
    }
    if (-not $Port) { $Port = 8443 }
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
    $env:HOMELAB_DESKTOP_PORT = "$Port"
    $env:HOMELAB_DESKTOP_IMAGE = "homelab-desktop-$Project"
    Compose config --quiet
    if ($Check) { Write-Host 'Windows container launcher/Compose configuration check passed. No services started.'; exit 0 }
    if (-not (DockerEngineReady)) {
        $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktop)) { throw 'Start Docker Desktop using Linux containers, then run start.bat again.' }
        Write-Host 'Starting Docker Desktop; waiting for the Linux container engine...'
        Start-Process -FilePath $desktop -WindowStyle Hidden
        $deadline = (Get-Date).AddMinutes(3)
        do {
            Start-Sleep -Seconds 2
            $engineReady = DockerEngineReady
            if ($engineReady) { break }
        } while ((Get-Date) -lt $deadline)
        if (-not $engineReady) { throw 'Docker Desktop did not become ready. Finish its initial setup and select Linux containers, then retry.' }
    }
    if ((Docker info --format '{{.OSType}}') -ne 'linux') { throw 'Switch Docker Desktop to Linux containers, then retry.' }
    # Never adopt or change permissions on a same-named foreign volume.
    foreach ($logical in @('install_state','runtime_config','migration_config','provision_config','postgres_config','postgres_data','artifacts','caddy_data','caddy_config')) {
        $volumeName = "${Project}_$logical"
        if (DockerProbe volume inspect $volumeName) {
            $labels = (Docker volume inspect --format '{{json .Labels}}' $volumeName) | ConvertFrom-Json
            if ($labels.'com.docker.compose.project' -ne $Project -or $labels.'com.docker.compose.volume' -ne $logical) { throw "Volume $volumeName is not owned by this installation. Nothing will be initialized or changed; select a different project or recover the correct original volumes." }
        }
    }
    $proxyId = Compose ps --all --quiet proxy
    if (-not $proxyId) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
        try { $listener.Start() } catch { throw "Local port $Port is in use. Nothing was stopped. Use start.bat -Port 8444 (with a new -Project if already configured)." } finally { $listener.Stop() }
    }
    if (-not $settings) {
        New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
        @{ version = 1; project = $Project; port = $Port } | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    }
    $missingImage = $false
    foreach ($target in @('api', 'worker', 'proxy')) {
        if (-not (DockerProbe image inspect "$($env:HOMELAB_DESKTOP_IMAGE):$target" --format '{{.Id}}')) { $missingImage = $true }
    }
    if ($missingImage) {
        if (DockerProbe volume inspect "${Project}_install_state") {
            throw 'This project already has persistent installation state but one of its images is missing. Restore the original images or follow the reviewed stop/drain/backup/upgrade procedure before rebuilding; startup will not rebuild an active installation.'
        }
        Write-Host 'First launch: building the pinned application containers. This can take several minutes.'
        Compose build api worker proxy
    }
    Compose run --rm -T --no-deps initialize configure
    $stage = Compose run --rm -T --no-deps initialize status
    if ($stage -notcontains 'installed') {
        Write-Host 'Preparing the persistent database and restricted application roles...'
        Compose up -d --wait --wait-timeout 180 postgres
        Compose run --rm -T --no-deps provision
    }
    # Uses the same installed image as the API; checksum/advisory-lock protected and idempotent.
    Compose up -d --wait --wait-timeout 180 postgres
    Compose run --rm -T --no-deps migrate
    if ($stage -notcontains 'installed') {
        Compose run --rm -T --no-deps initialize installed
    }
    Compose up -d --no-build --wait --wait-timeout 240 postgres api worker proxy
    $proxyId = Compose ps --quiet proxy
    $proxyLabels = (Docker inspect --format '{{json .Config.Labels}}' $proxyId) | ConvertFrom-Json
    if ($proxyLabels.'com.docker.compose.project' -ne $Project -or $proxyLabels.'com.docker.compose.service' -ne 'proxy') { throw 'HTTPS proxy ownership did not match this installation.' }
    $proxyMounts = (Docker inspect --format '{{json .Mounts}}' $proxyId) | ConvertFrom-Json
    $caVolume = @($proxyMounts | Where-Object { $_.Destination -eq '/data' -and $_.Type -eq 'volume' })
    if ($caVolume.Count -ne 1) { throw 'HTTPS CA is not in the expected persistent named volume.' }
    $volumeLabels = (Docker volume inspect --format '{{json .Labels}}' $caVolume[0].Name) | ConvertFrom-Json
    if ($volumeLabels.'com.docker.compose.project' -ne $Project -or $volumeLabels.'com.docker.compose.volume' -ne 'caddy_data') { throw 'HTTPS CA volume ownership did not match this installation.' }
    $certPath = Join-Path $localRoot 'root.crt'
    Compose cp proxy:/data/caddy/pki/authorities/local/root.crt $certPath
    $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
    $caExtension = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' }
    if (-not $caExtension) { throw 'Exported certificate has no CA constraint.' }
    $constraints = [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($caExtension, $caExtension.Critical)
    if (-not $constraints.CertificateAuthority -or $cert.Subject -ne $cert.Issuer -or $cert.NotAfter -lt (Get-Date) -or $cert.NotBefore -gt (Get-Date)) { throw 'Exported installation CA is invalid.' }
    $trustPath = Join-Path $localRoot 'ca-identity.json'
    if (Test-Path -LiteralPath $trustPath) {
        $previousCA = Get-Content -LiteralPath $trustPath -Raw | ConvertFrom-Json
        if ($previousCA.thumbprint -ne $cert.Thumbprint -or $previousCA.volume -ne $caVolume[0].Name) { throw 'Installation CA identity changed. Review the original persistent CA/data before trusting a replacement.' }
    }
    # Use the Windows certificate store directly: a launcher invoked through cmd
    # can inherit a PowerShell 7 module path that breaks the PS5 Cert: provider.
    $rootStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    try {
        $rootStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        $trusted = $rootStore.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $cert.Thumbprint, $false)
        if ($trusted.Count -eq 0) {
            Write-Host "Trusting this installation's locally generated HTTPS CA for the current Windows user: $($cert.Thumbprint)"
            $rootStore.Add($cert)
        }
    } finally { $rootStore.Close() }
    @{ project = $Project; volume = $caVolume[0].Name; thumbprint = $cert.Thumbprint } | ConvertTo-Json | Set-Content -LiteralPath $trustPath -Encoding UTF8
    $url = "https://localhost:$Port"
    $ready = Read-LocalDashboardJson "$url/readyz" $certPath
    if ($ready.status -ne 'ready') { throw 'HTTPS readiness did not report ready.' }
    $auth = Read-LocalDashboardJson "$url/api/v1/auth/status" $certPath
    Write-Host "Ready: $url (production HTTPS; dispatch remains disabled by default)."
    if ($auth.bootstrap_required) {
        Write-Host 'In the dashboard choose First time? Set up owner, then enter your own email and a password of at least 12 characters.'
        if (-not $NoToken) {
            $token = Compose run --rm -T --no-deps initialize token
            Write-Host 'Setup token (keep private; available again by rerunning this launcher until owner setup is complete):'
            Write-Host ($token -join "`n")
            $token = $null
        } else { Write-Host 'Setup token suppressed by -NoToken. Normal launch displays it locally until owner setup is complete.' }
    } else { Write-Host 'Sign in with your existing owner account.' }
    if (-not $NoBrowser) { Start-Process $url }
    exit 0
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'No persistent data was deleted. Fix the reported prerequisite/error and rerun start.bat to resume.'
    exit 1
} finally {
    if ($ownsLock) { $launchLock.ReleaseMutex() }
    if ($launchLock) { $launchLock.Dispose() }
}
