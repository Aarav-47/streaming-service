# ============================================================
#  Streaming Service -- Automated Windows Service Installer
#  Delegates to install-windows.ps1 for complete setup
# ============================================================

param(
  [string]$TunnelToken = "eyJhIjoiZjE2MWM4MWExOTkzYmFiZDg2MDk1NGMyYWZlODZhYmQiLCJ0IjoiMmM4NjM3Y2YtYjlhNy00ZGI3LTkyOWYtZTU1MTJjZGQ2NmMyIiwicyI6IllUazVZakptWVdJdFl6RXlOQzAwTWpZNExXSTNNR0V0TldJNFltVTJPREF4TldNeiJ9",
  [string]$ServiceName  = "StreamingService",
  [string]$DisplayName  = "Streaming Service (Live Feeds)",
  [string]$InstallDir   = $PSScriptRoot
)

& "$PSScriptRoot\install-windows.ps1" -TunnelToken $TunnelToken -ServiceName $ServiceName -DisplayName $DisplayName -InstallDir $InstallDir
