param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$ReadyFile,
  [Parameter(Mandatory=$true)][string]$ReleaseFile
)
$ErrorActionPreference = 'Stop'
$heldFile = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
try {
  [System.IO.File]::WriteAllText($ReadyFile, 'held-without-delete-sharing')
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  while (-not [System.IO.File]::Exists($ReleaseFile) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
} finally { $heldFile.Dispose() }
