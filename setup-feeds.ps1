# setup-feeds.ps1
# Run this once to create feeds.json with all 23 configured feeds starting from S.No 01.
# Uses WriteAllText without UTF-8 BOM.

$feeds = '[
  { "id": "feed_51", "name": "01 - Feed 51", "ip": "192.168.29.51", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.51:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_42", "name": "02 - Feed 42", "ip": "192.168.29.42", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.42:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_53", "name": "03 - Feed 53", "ip": "192.168.29.53", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.53:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_47", "name": "04 - Feed 47", "ip": "192.168.29.47", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.47:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_49", "name": "05 - Feed 49", "ip": "192.168.29.49", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.49:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_45", "name": "06 - Feed 45", "ip": "192.168.29.45", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.45:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_58", "name": "07 - Feed 58", "ip": "192.168.29.58", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.58:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_48", "name": "08 - Feed 48", "ip": "192.168.29.48", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.48:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_52", "name": "09 - Feed 52", "ip": "192.168.29.52", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.52:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_44", "name": "10 - Feed 44", "ip": "192.168.29.44", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.44:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_43", "name": "11 - Feed 43", "ip": "192.168.29.43", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.43:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_50", "name": "12 - Feed 50", "ip": "192.168.29.50", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.50:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_25", "name": "13 - Feed 25", "ip": "192.168.29.25", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.25:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_27", "name": "14 - Feed 27", "ip": "192.168.29.27", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.27:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_26", "name": "15 - Feed 26", "ip": "192.168.29.26", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.26:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_29", "name": "16 - Feed 29", "ip": "192.168.29.29", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.29:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_31", "name": "17 - Feed 31", "ip": "192.168.29.31", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.31:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_205", "name": "18 - Feed 205", "ip": "192.168.29.205", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.205:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_201", "name": "19 - Feed 201", "ip": "192.168.29.201", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.201:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_204", "name": "20 - Feed 204", "ip": "192.168.29.204", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.204:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_202", "name": "21 - Feed 202", "ip": "192.168.29.202", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.202:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_203", "name": "22 - Feed 203", "ip": "192.168.29.203", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.203:554/cam/realmonitor?channel=1&subtype=0" },
  { "id": "feed_46", "name": "23 - Feed 46", "ip": "192.168.29.46", "port": 554, "username": "admin", "password": "admin@123", "channel": 1, "subtype": 0, "url": "rtsp://admin:admin%40123@192.168.29.46:554/cam/realmonitor?channel=1&subtype=0" }
]'

# Write WITHOUT BOM (fixes the silent JSON parse failure on Windows)
[System.IO.File]::WriteAllText(
  "$PSScriptRoot\feeds.json",
  $feeds,
  (New-Object System.Text.UTF8Encoding $false)
)

$count = (Get-Content "$PSScriptRoot\feeds.json" -Raw | ConvertFrom-Json).Count
Write-Host "[OK] feeds.json written with $count feeds in sequence 01 to 23." -ForegroundColor Green

# Restart the service to pick up the new config
$svc = Get-Service -Name "StreamingService" -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "[...] Restarting StreamingService..." -ForegroundColor Yellow
  Restart-Service StreamingService
  Start-Sleep -Seconds 3
  Write-Host "[OK] Done! Open http://localhost:3000" -ForegroundColor Green
} else {
  Write-Host "[INFO] StreamingService not installed yet. Run install-service.ps1 first." -ForegroundColor Yellow
}
