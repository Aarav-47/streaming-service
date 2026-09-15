# Uninstall Streaming Service Windows Service

param([string]$ServiceName = "StreamingService")

$nssmExe = "$PSScriptRoot\nssm\nssm.exe"

if (-not (Test-Path $nssmExe)) {
  Write-Error "NSSM not found. Service may not have been installed via install-service.ps1."
  exit 1
}

Write-Host "Stopping and removing '$ServiceName' Windows Service..." -ForegroundColor Yellow
& $nssmExe stop   $ServiceName confirm 2>$null
& $nssmExe remove $ServiceName confirm 2>$null

Write-Host "[OK] Service '$ServiceName' removed successfully." -ForegroundColor Green
