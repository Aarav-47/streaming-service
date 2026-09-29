# ============================================================
#  Streaming Service -- Windows Automated Backup Server Setup
#  High-Availability (HA) Failover Node
#  Run this ONCE in PowerShell as Administrator.
# ============================================================

param(
  [string]$TunnelToken = "eyJhIjoiZjE2MWM4MWExOTkzYmFiZDg2MDk1NGMyYWZlODZhYmQiLCJ0IjoiMmM4NjM3Y2YtYjlhNy00ZGI3LTkyOWYtZTU1MTJjZGQ2NmMyIiwicyI6IllUazVZakptWVdJdFl6RXlOQzAwTWpZNExXSTNNR0V0TldJNFltVTJPREF4TldNeiJ9",
  [string]$ServiceName = "StreamingService",
  [string]$DisplayName = "Streaming Service (Live Feeds)",
  [string]$InstallDir  = $PSScriptRoot,
  [int]$Port           = 3000
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "   Streaming Service -- Windows Backup Server Installer       " -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# -- 0. Verify Administrator Privileges
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
$adminRole = [Security.Principal.WindowsBuiltInRole]::Administrator
if (-not $principal.IsInRole($adminRole)) {
  Write-Warning "Administrator privileges required. Requesting elevation..."
  Start-Process powershell -Verb runAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  exit
}

# Configure TLS 1.2
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# -- 1. Check / Install Node.js
Write-Host "[1/6] Checking Node.js runtime..." -ForegroundColor Yellow
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "  -> Node.js not found. Installing via winget..." -ForegroundColor Yellow
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    & winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
  } else {
    Write-Host "  -> Downloading Node.js LTS installer..." -ForegroundColor Yellow
    $msiPath = "$env:TEMP\node-lts.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi" -OutFile $msiPath -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn /norestart" -Wait
    Remove-Item $msiPath -Force -ErrorAction SilentlyContinue
  }
  $machinePath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::Machine)
  $userPath = [System.Environment]::GetEnvironmentVariable("Path", [System.EnvironmentVariableTarget]::User)
  $env:Path = "$machinePath;$userPath"
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    Write-Error "Please install Node.js from https://nodejs.org and re-run this script."
    exit 1
  }
}
Write-Host "  [OK] Node.js found: $($node.Source)" -ForegroundColor Green

# -- 2. Check / Install FFmpeg
Write-Host "[2/6] Checking FFmpeg engine..." -ForegroundColor Yellow
$ffmpegDir = "$InstallDir\ffmpeg"
$ffmpegExe = "$ffmpegDir\bin\ffmpeg.exe"

if (-not (Test-Path $ffmpegExe) -and -not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "  -> Downloading FFmpeg (~75MB)..." -ForegroundColor Yellow
  $ffmpegZip = "$env:TEMP\ffmpeg.zip"
  $ffmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  try {
    Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing
    Write-Host "  -> Extracting FFmpeg..." -ForegroundColor Yellow
    Expand-Archive -Path $ffmpegZip -DestinationPath "$env:TEMP\ffmpeg_extract" -Force
    $extracted = Get-ChildItem "$env:TEMP\ffmpeg_extract" -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Path $ffmpegDir -Force | Out-Null
    Copy-Item "$($extracted.FullName)\bin" "$ffmpegDir" -Recurse -Force
    Remove-Item $ffmpegZip -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\ffmpeg_extract" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  [OK] FFmpeg installed at: $ffmpegExe" -ForegroundColor Green
  } catch {
    Write-Warning "Direct FFmpeg download failed. Attempting winget install Gyan.FFmpeg..."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      & winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements
    }
  }
} else {
  Write-Host "  [OK] FFmpeg is ready." -ForegroundColor Green
}

# -- 3. Install npm dependencies
Write-Host "[3/6] Installing npm dependencies..." -ForegroundColor Yellow
Push-Location $InstallDir
npm install --omit=dev --silent
Pop-Location
Write-Host "  [OK] npm dependencies up to date." -ForegroundColor Green

# -- 4. Verify feeds configuration
Write-Host "[4/6] Verifying feeds configuration..." -ForegroundColor Yellow
if (-not (Test-Path "$InstallDir\feeds.json")) {
  Write-Host "  -> Generating feeds.json with all 23 configured feeds..." -ForegroundColor Yellow
  & powershell -ExecutionPolicy Bypass -File "$InstallDir\setup-feeds.ps1"
} else {
  $feedCount = (Get-Content "$InstallDir\feeds.json" -Raw | ConvertFrom-Json).Count
  Write-Host "  [OK] feeds.json verified with $feedCount feeds configured." -ForegroundColor Green
}

# -- 5. Register Streaming Service as 24/7 Windows Service
Write-Host "[5/6] Setting up StreamingService Windows Service..." -ForegroundColor Yellow
$nssmDir = "$InstallDir\nssm"
$nssmExe = "$nssmDir\nssm.exe"

if (-not (Test-Path $nssmExe)) {
  Write-Host "  -> Downloading NSSM service helper..." -ForegroundColor Yellow
  $nssmZip = "$env:TEMP\nssm.zip"
  try {
    Invoke-WebRequest -Uri "https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip" -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath "$env:TEMP\nssm_extract" -Force
    New-Item -ItemType Directory -Path $nssmDir -Force | Out-Null
    $nssmBin = Get-ChildItem "$env:TEMP\nssm_extract" -Recurse -Filter "nssm.exe" |
      Where-Object { $_.FullName -like "*win64*" } | Select-Object -First 1
    if (-not $nssmBin) {
      $nssmBin = Get-ChildItem "$env:TEMP\nssm_extract" -Recurse -Filter "nssm.exe" | Select-Object -First 1
    }
    Copy-Item $nssmBin.FullName $nssmExe -Force
    Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\nssm_extract" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  [OK] NSSM ready." -ForegroundColor Green
  } catch {
    Write-Error "Failed to download NSSM. Check your internet connection."
    exit 1
  }
}

# Remove previous service instance cleanly if registered
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "  -> Refreshing previous service instance..." -ForegroundColor Yellow
  try { & $nssmExe stop $ServiceName confirm 2>$null } catch {}
  Start-Sleep -Seconds 1
  try { & $nssmExe remove $ServiceName confirm 2>$null } catch {}
  Start-Sleep -Seconds 1
}

$nodePath = (Get-Command node).Source
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null

& $nssmExe install  $ServiceName $nodePath
& $nssmExe set      $ServiceName AppParameters  "server.js"
& $nssmExe set      $ServiceName AppDirectory   $InstallDir
& $nssmExe set      $ServiceName DisplayName    $DisplayName
& $nssmExe set      $ServiceName Description    "Streaming Service - Live video feeds with Cloudflare Tunnel Failover"
& $nssmExe set      $ServiceName Start          SERVICE_AUTO_START
& $nssmExe set      $ServiceName AppRestartDelay 3000
& $nssmExe set      $ServiceName AppStdout      "$InstallDir\logs\service.log"
& $nssmExe set      $ServiceName AppStderr      "$InstallDir\logs\service-error.log"
& $nssmExe set      $ServiceName AppRotateFiles  1
& $nssmExe set      $ServiceName AppRotateBytes  5242880

Write-Host "  -> Starting StreamingService..." -ForegroundColor Yellow
& $nssmExe start $ServiceName
Start-Sleep -Seconds 2
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
  Write-Host "  [OK] StreamingService is RUNNING in background!" -ForegroundColor Green
} else {
  Write-Warning "StreamingService status: $($svc.Status). Logs at: $InstallDir\logs\service.log"
}

# -- 6. Cloudflare Tunnel Failover Setup
Write-Host "[6/6] Configuring Cloudflare Tunnel Connector..." -ForegroundColor Yellow

$cfCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
$cfExePath = $null

if ($cfCmd) {
  $cfExePath = $cfCmd.Source
} else {
  $cfDestDir = "C:\Program Files\cloudflared"
  $cfDestExe = "$cfDestDir\cloudflared.exe"
  if (-not (Test-Path $cfDestExe)) {
    Write-Host "  -> Downloading cloudflared.exe..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $cfDestDir -Force | Out-Null
    $cfUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    Invoke-WebRequest -Uri $cfUrl -OutFile $cfDestExe -UseBasicParsing
  }
  $cfExePath = $cfDestExe
}

# Reinstall/Start cloudflared service
$cfSvc = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cfSvc) {
  Write-Host "  -> Stopping old cloudflared service..." -ForegroundColor Yellow
  try { & $cfExePath service uninstall 2>$null } catch {}
  Start-Sleep -Seconds 2
}

Write-Host "  -> Registering cloudflared service with failover token..." -ForegroundColor Yellow
& $cfExePath service install $TunnelToken
Start-Sleep -Seconds 2
Start-Service cloudflared -ErrorAction SilentlyContinue
Set-Service -Name cloudflared -StartupType Automatic -ErrorAction SilentlyContinue

$cfSvc = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cfSvc -and $cfSvc.Status -eq "Running") {
  Write-Host "  [OK] Cloudflare Tunnel service is RUNNING and connected!" -ForegroundColor Green
} else {
  Write-Host "  [INFO] Cloudflare Tunnel service configured (status: $($cfSvc.Status))." -ForegroundColor Yellow
}

# Firewall rule for local LAN access (optional)
try {
  netsh advfirewall firewall add rule name="Streaming Service Web (Port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=any 2>$null | Out-Null
} catch {}

# -- Final Summary
Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "   [OK] WINDOWS BACKUP SERVER SETUP COMPLETE!                 " -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Cyan
$svcStatus = (Get-Service StreamingService -ErrorAction SilentlyContinue).Status
$cfStatus = (Get-Service cloudflared -ErrorAction SilentlyContinue).Status
Write-Host " - Service 1: StreamingService -> $svcStatus" -ForegroundColor White
Write-Host " - Service 2: cloudflared      -> $cfStatus" -ForegroundColor White
Write-Host ""
Write-Host " High Availability (Active-Active Failover):" -ForegroundColor Cyan
Write-Host "   - Node 1: Mac Mini (Bhakts-Mac-mini-2.local)" -ForegroundColor White
Write-Host "   - Node 2: Windows PC ($env:COMPUTERNAME)" -ForegroundColor White
Write-Host "   - Live URL:  https://aa.horizonhuedigital.in" -ForegroundColor Yellow
Write-Host "   - Local URL: http://localhost:3000" -ForegroundColor White
Write-Host ""
Write-Host " Both servers run simultaneously. If one machine is shut down," -ForegroundColor Green
Write-Host " sleeps, or loses power, the other handles 100% of the feeds" -ForegroundColor Green
Write-Host " automatically with ZERO downtime!" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""
