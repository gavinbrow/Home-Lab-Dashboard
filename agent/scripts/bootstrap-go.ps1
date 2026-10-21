$ErrorActionPreference = 'Stop'
$agentDirectory = Split-Path -Parent $PSScriptRoot
$toolsDirectory = Join-Path $agentDirectory '.tools'
$version = 'go1.27.3'
$archive = Join-Path $toolsDirectory "$version.windows-amd64.zip"
$expected = 'f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff'
New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest "https://go.dev/dl/$version.windows-amd64.zip" -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Go SDK SHA-256 mismatch' }
$goExecutable = Join-Path $toolsDirectory 'go\bin\go.exe'
if (-not (Test-Path -LiteralPath $goExecutable)) { Expand-Archive -LiteralPath $archive -DestinationPath $toolsDirectory }
& $goExecutable version
if ($LASTEXITCODE -ne 0) { throw 'Go SDK did not run' }
