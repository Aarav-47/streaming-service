# Streaming Service

A self-hosted live video streaming web application and Android PWA. Streams IP camera feeds over WebSocket using a 100% custom Node.js + FFmpeg engine with no third-party streaming middleware.

Runs as a native Windows background service that starts automatically on boot.

---

## Features
- **Custom WebSocket streaming engine** — FFmpeg spawned per viewer, zero-copy MPEG1 video piped to browser via WebSocket
- **JSMpeg canvas player** — ~200ms ultra-low latency playback in any browser, no plugins
- **Android PWA** — Install directly from Chrome as a native app on Android home screen
- **JWT Authentication** — Session-based login, 30-day persistent cookie
- **Dynamic Camera Management** — Add, edit or remove camera feeds from the UI without restarting
- **Windows Auto-Start Service** — Registered as a native Windows Service (NSSM), starts before user login
- **Cloudflare Tunnel** — Served to a public URL without port forwarding or static IP

---

## Stack
| Layer | Technology |
|:------|:-----------|
| Streaming Engine | Node.js + FFmpeg (RTSP → MPEG1 → WebSocket) |
| Video Player | JSMpeg (canvas-based MPEG1 decoder) |
| Backend API | Express.js + `ws` (WebSocket) |
| Auth | JWT (jsonwebtoken) + HttpOnly cookies |
| Frontend | Vanilla JS + HTML5 + CSS |
| Mobile App | PWA (manifest + service worker) |
| Tunnel | Cloudflare Tunnel (`cloudflared`) |
| Windows Service | NSSM (auto-installed by setup script) |

---

## Quick Setup (Windows)

### Prerequisites
- [Node.js LTS](https://nodejs.org/) installed
- A Cloudflare account with `horizonhuedigital.in` (or your domain) added

### 1. Clone the repo
```powershell
git clone https://github.com/horizonhuedigital/streaming-service.git
cd streaming-service
```

### 2. Create your `cameras.json`
Copy the example and fill in your camera IPs and credentials:
```powershell
Copy-Item cameras.example.json cameras.json
```
Edit `cameras.json` with your camera details.

### 3. Install as Windows Service (One Command)
Open PowerShell **as Administrator** and run:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install-service.ps1
```
This automatically:
* Downloads and extracts FFmpeg
* Downloads NSSM
* Installs `npm` dependencies
* Registers `StreamingService` as a native Windows Service
* Starts the service immediately

### 4. Verify
Open your browser to **`http://localhost:3000`**
- **Username:** `admin`
- **Password:** `admin@123` *(change in `.env`)*

---

## Cloudflare Tunnel Setup
```powershell
# 1. Login (opens browser, select your domain)
cloudflared tunnel login

# 2. Create tunnel
cloudflared tunnel create streams

# 3. Route your subdomain
cloudflared tunnel route dns streams aa.horizonhuedigital.in

# 4. Create config
@"
tunnel: streams
credentials-file: $env:USERPROFILE\.cloudflared\streams.json
ingress:
  - hostname: aa.horizonhuedigital.in
    service: http://localhost:3000
  - service: http_status:404
"@ | Out-File "$env:USERPROFILE\.cloudflared\config.yml" -Encoding ascii

# 5. Install as Windows Service (auto-starts on boot)
cloudflared service install
Start-Service cloudflared
```

---

## Environment Variables (`.env`)
```env
PORT=3000
ADMIN_USER=admin
ADMIN_PASS=admin@123
JWT_SECRET=your_custom_secret_here
```

---

## Android App
1. Open Chrome on Android → navigate to `https://aa.horizonhuedigital.in`
2. Tap **"Install App"** button (or Chrome menu → **Add to Home Screen**)
3. App runs in full-screen standalone mode

---

## Service Management
```powershell
# Stop service
Stop-Service StreamingService

# Start service
Start-Service StreamingService

# View logs
Get-Content .\logs\service.log -Tail 50 -Wait

# Uninstall service
.\uninstall-service.ps1
```

---

## cameras.json Format
> ⚠️ `cameras.json` is in `.gitignore` — **never commit camera credentials to Git!**

```json
[
  {
    "id": "cam_1",
    "name": "Main Entrance",
    "ip": "192.168.1.50",
    "port": 554,
    "username": "admin",
    "password": "your_password",
    "channel": 1,
    "subtype": 0,
    "url": "rtsp://admin:your_password@192.168.1.50:554/cam/realmonitor?channel=1&subtype=0"
  }
]
```

---

## License
MIT © Horizon Hue Digital
