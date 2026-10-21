param(
  [Parameter(Mandatory = $true)][string]$PostgresBin,
  [ValidateSet('integration', 'all')][string]$Suite = 'integration'
)
$ErrorActionPreference = 'Stop'
$testDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot)
$runtimeDirectory = Join-Path $testDirectory '.runtime'
$clusterName = 'postgres-' + [guid]::NewGuid().ToString('N')
$clusterDirectory = [System.IO.Path]::GetFullPath((Join-Path $runtimeDirectory $clusterName))
$runtimePrefix = [System.IO.Path]::GetFullPath($runtimeDirectory).TrimEnd('\') + '\'
if (-not $clusterDirectory.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Cluster path escaped owned test runtime' }
foreach ($executable in @('initdb.exe', 'pg_ctl.exe', 'postgres.exe')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PostgresBin $executable))) { throw "Missing PostgreSQL executable: $executable" }
}
$previousUrl = $env:HOMELAB_LOCAL_PG_URL
$serverStarted = $false
$startupAttempted = $false
$testExit = 1
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
try {
  & (Join-Path $PostgresBin 'postgres.exe') --version
  & (Join-Path $PostgresBin 'initdb.exe') -D $clusterDirectory -U homelab_test -A trust --encoding=UTF8 --locale=C
  if ($LASTEXITCODE -ne 0) { throw 'Isolated initdb failed' }
  $portReservation = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $portReservation.Start()
  $testPort = $portReservation.LocalEndpoint.Port
  $portReservation.Stop()
  $startupAttempted = $true
  & (Join-Path $PostgresBin 'pg_ctl.exe') -D $clusterDirectory -l (Join-Path $runtimeDirectory ($clusterName + '.log')) -o "-h 127.0.0.1 -p $testPort" -w start
  if ($LASTEXITCODE -ne 0) { throw 'Isolated PostgreSQL startup failed' }
  $serverStarted = $true
  $env:HOMELAB_LOCAL_PG_URL = "postgresql://homelab_test@127.0.0.1:$testPort/postgres"
  Push-Location (Split-Path (Split-Path $testDirectory -Parent) -Parent)
  try {
    if ($Suite -eq 'all') { & npm.cmd test } else { & npm.cmd run test:integration }
    $testExit = $LASTEXITCODE
  } finally { Pop-Location }
} finally {
  if ($null -eq $previousUrl) { Remove-Item Env:HOMELAB_LOCAL_PG_URL -ErrorAction SilentlyContinue } else { $env:HOMELAB_LOCAL_PG_URL = $previousUrl }
  $safeToRemove = -not $startupAttempted
  if ($startupAttempted) {
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $clusterDirectory status
    $clusterStatus = $LASTEXITCODE
    if ($clusterStatus -eq 0) {
      & (Join-Path $PostgresBin 'pg_ctl.exe') -D $clusterDirectory -m fast -w stop
      $safeToRemove = $LASTEXITCODE -eq 0
    } elseif ($clusterStatus -eq 3) { $safeToRemove = $true }
    if (-not $safeToRemove) { Write-Warning "Owned test cluster state was not confirmed stopped; retained $clusterDirectory for inspection" }
  }
  if ($safeToRemove -and $clusterDirectory.StartsWith($runtimePrefix, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path $clusterDirectory -Leaf) -eq $clusterName) {
    if (Test-Path -LiteralPath $clusterDirectory) { Remove-Item -LiteralPath $clusterDirectory -Recurse -Force }
  }
}
exit $testExit
