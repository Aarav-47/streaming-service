# ============================================================
#  Streaming Service -- Windows Service Uninstaller
#  Run in PowerShell as Administrator to stop and remove services.
# ============================================================

param(
  [string]$ServiceName = "StreamingService"
)

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
$adminRole = [Security.Principal.WindowsBuiltInRole]::Administrator
if (-not $principal.IsInRole($adminRole)) {
  Write-Warning "Administrator privileges required. Requesting elevation..."
  Start-Process powershell -Verb runAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

Write-Host "[Streaming Service] Removing Windows Services..." -ForegroundColor Yellow

$nssmExe = "$PSScriptRoot\nssm\nssm.exe"
if (Test-Path $nssmExe) {
  try { & $nssmExe stop $ServiceName confirm 2>$null } catch {}
  Start-Sleep -Seconds 1
  try { & $nssmExe remove $ServiceName confirm 2>$null } catch {}
  Write-Host "[OK] Removed $ServiceName" -ForegroundColor Green
}

$cfCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cfCmd) {
  try { & $cfCmd.Source service uninstall 2>$null } catch {}
  Write-Host "[OK] Cloudflared service uninstalled" -ForegroundColor Green
} elseif (Test-Path "C:\Program Files\cloudflared\cloudflared.exe") {
  try { & "C:\Program Files\cloudflared\cloudflared.exe" service uninstall 2>$null } catch {}
  Write-Host "[OK] Cloudflared service uninstalled" -ForegroundColor Green
}

# Remove firewall rule
try {
  netsh advfirewall firewall delete rule name="Streaming Service Web (Port 3000)" 2>$null | Out-Null
} catch {}

Write-Host "Uninstallation complete." -ForegroundColor Green
