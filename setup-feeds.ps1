# setup-feeds.ps1
# Run this once to create feeds.json with your 17 configured feeds.
# Uses WriteAllText to avoid the UTF-8 BOM issue with Out-File.

$feeds = '[
  { "id": "feed_25", "name": "Feed 25", "ip": "192.168.29.25", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.25:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_26", "name": "Feed 26", "ip": "192.168.29.26", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.26:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_27", "name": "Feed 27", "ip": "192.168.29.27", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.27:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_29", "name": "Feed 29", "ip": "192.168.29.29", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.29:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_31", "name": "Feed 31", "ip": "192.168.29.31", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.31:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_43", "name": "Feed 43", "ip": "192.168.29.43", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.43:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_44", "name": "Feed 44", "ip": "192.168.29.44", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.44:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_45", "name": "Feed 45", "ip": "192.168.29.45", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.45:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_46", "name": "Feed 46", "ip": "192.168.29.46", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.46:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_47", "name": "Feed 47", "ip": "192.168.29.47", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.47:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_48", "name": "Feed 48", "ip": "192.168.29.48", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.48:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_49", "name": "Feed 49", "ip": "192.168.29.49", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.49:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_50", "name": "Feed 50", "ip": "192.168.29.50", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.50:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_51", "name": "Feed 51", "ip": "192.168.29.51", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.51:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_52", "name": "Feed 52", "ip": "192.168.29.52", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.52:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_53", "name": "Feed 53", "ip": "192.168.29.53", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.53:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_58", "name": "Feed 58", "ip": "192.168.29.58", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.58:554/cam/realmonitor?channel=1&subtype=0" }
]'

# Write WITHOUT BOM (fixes the silent JSON parse failure on Windows)
[System.IO.File]::WriteAllText(
  "$PSScriptRoot\feeds.json",
  $feeds,
  (New-Object System.Text.UTF8Encoding $false)
)

Write-Host "[OK] feeds.json written successfully with $((Get-Content "$PSScriptRoot\feeds.json" | ConvertFrom-Json).Count) feeds." -ForegroundColor Green

# Restart the service to pick up the new config
$svc = Get-Service -Name "StreamingService" -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "[...] Restarting StreamingService..." -ForegroundColor Yellow
  Restart-Service StreamingService
  Start-Sleep -Seconds 3
  Write-Host "[OK] Service restarted. Open http://localhost:3000" -ForegroundColor Green
} else {
  Write-Host "[INFO] StreamingService not installed yet. Run install-service.ps1 first." -ForegroundColor Yellow
}
