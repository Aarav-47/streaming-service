# ============================================================
#  Streaming Service -- Automated Windows Service Installer
#  Run this ONCE as Administrator.
#  After this, service starts automatically on every boot.
# ============================================================

param(
  [string]$ServiceName  = "StreamingService",
  [string]$DisplayName  = "Streaming Service (Live Feeds)",
  [string]$InstallDir   = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "[Streaming Service] Windows Service Installer" -ForegroundColor Cyan
Write-Host "----------------------------------------------" -ForegroundColor Cyan

# -- 1. Check Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error "Node.js is not installed. Please install from https://nodejs.org and re-run."
  exit 1
}
Write-Host "[OK] Node.js found: $($node.Source)" -ForegroundColor Green

# -- 2. Install npm dependencies if needed
if (-not (Test-Path "$InstallDir\node_modules")) {
  Write-Host "[...] Installing npm dependencies..." -ForegroundColor Yellow
  Push-Location $InstallDir
  npm install --silent
  Pop-Location
  Write-Host "[OK] npm dependencies installed" -ForegroundColor Green
}

# -- 3. Download FFmpeg if not already present
$ffmpegDir = "$InstallDir\ffmpeg"
$ffmpegExe = "$ffmpegDir\bin\ffmpeg.exe"

if (-not (Test-Path $ffmpegExe)) {
  Write-Host "[...] Downloading FFmpeg (one-time, ~75MB)..." -ForegroundColor Yellow
  $ffmpegZip = "$env:TEMP\ffmpeg.zip"
  $ffmpegUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $ffmpegUrl -OutFile $ffmpegZip -UseBasicParsing
    Write-Host "[...] Extracting FFmpeg..." -ForegroundColor Yellow
    Expand-Archive -Path $ffmpegZip -DestinationPath "$env:TEMP\ffmpeg_extract" -Force
    $extracted = Get-ChildItem "$env:TEMP\ffmpeg_extract" -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Path $ffmpegDir -Force | Out-Null
    Copy-Item "$($extracted.FullName)\bin" "$ffmpegDir" -Recurse -Force
    Remove-Item $ffmpegZip -Force
    Remove-Item "$env:TEMP\ffmpeg_extract" -Recurse -Force
    Write-Host "[OK] FFmpeg installed at: $ffmpegExe" -ForegroundColor Green
  } catch {
    Write-Warning "FFmpeg auto-download failed. Manually place ffmpeg.exe in $ffmpegDir\bin\"
  }
} else {
  Write-Host "[OK] FFmpeg already present." -ForegroundColor Green
}

# -- 4. Download NSSM if not already present
$nssmDir = "$InstallDir\nssm"
$nssmExe = "$nssmDir\nssm.exe"

if (-not (Test-Path $nssmExe)) {
  Write-Host "[...] Downloading NSSM (Windows Service manager)..." -ForegroundColor Yellow
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
    Remove-Item $nssmZip -Force
    Remove-Item "$env:TEMP\nssm_extract" -Recurse -Force
    Write-Host "[OK] NSSM installed." -ForegroundColor Green
  } catch {
    Write-Error "Failed to download NSSM. Check your internet connection."
    exit 1
  }
}

# -- 5. Remove old installation if exists
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[...] Removing previous service installation..." -ForegroundColor Yellow
  & $nssmExe stop   $ServiceName confirm 2>$null
  & $nssmExe remove $ServiceName confirm 2>$null
  Start-Sleep -Seconds 2
}

# -- 6. Register as Windows Service
Write-Host "[...] Registering Windows Service: $ServiceName ..." -ForegroundColor Yellow
$nodePath = (Get-Command node).Source
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null

& $nssmExe install  $ServiceName $nodePath
& $nssmExe set      $ServiceName AppParameters  "server.js"
& $nssmExe set      $ServiceName AppDirectory   $InstallDir
& $nssmExe set      $ServiceName DisplayName    $DisplayName
& $nssmExe set      $ServiceName Description    "Streaming Service - Live video feeds via Cloudflare Tunnel"
& $nssmExe set      $ServiceName Start          SERVICE_AUTO_START
& $nssmExe set      $ServiceName AppRestartDelay 5000
& $nssmExe set      $ServiceName AppStdout      "$InstallDir\logs\service.log"
& $nssmExe set      $ServiceName AppStderr      "$InstallDir\logs\service-error.log"
& $nssmExe set      $ServiceName AppRotateFiles  1
& $nssmExe set      $ServiceName AppRotateBytes  5242880

# -- 7. Start the service
Write-Host "[...] Starting service..." -ForegroundColor Yellow
& $nssmExe start $ServiceName
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "----------------------------------------------" -ForegroundColor Cyan
if ($svc -and $svc.Status -eq "Running") {
  Write-Host " [SUCCESS] StreamingService is RUNNING!" -ForegroundColor Green
  Write-Host " Starts automatically on every Windows boot." -ForegroundColor Green
} else {
  Write-Host " [WARNING] Service installed but check logs at: $InstallDir\logs\" -ForegroundColor Yellow
}
Write-Host ""
Write-Host " Dashboard : http://localhost:3000" -ForegroundColor Cyan
Write-Host " Login     : admin / admin@123" -ForegroundColor Cyan
Write-Host " Service   : StreamingService (visible in services.msc)" -ForegroundColor Cyan
Write-Host "----------------------------------------------" -ForegroundColor Cyan
