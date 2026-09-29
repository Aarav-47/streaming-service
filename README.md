# Streaming Service

A self-hosted live video streaming web application and PWA. Streams live video feeds over WebSocket using a 100% custom Node.js + FFmpeg engine with no third-party streaming middleware.

Runs as a native background service on both **macOS** (LaunchAgent daemon) and **Windows** (NSSM Windows Service) that starts automatically on boot.

---

## High-Availability (HA) Dual-Server Architecture

Deploying both your **Mac Mini** and **Windows PC** to the same Cloudflare Tunnel creates an active-active failover cluster:

```
                          ┌───────────────────────────┐
                          │ https://aa.horizonhuedigital.in │
                          └─────────────┬─────────────┘
                                        │
                         Cloudflare Edge Load Balancer
                               /             \
                              /               \
                             ▼                 ▼
                 ┌───────────────────────┐ ┌───────────────────────┐
                 │ Node 1: Mac Mini      │ │ Node 2: Windows PC    │
                 │ (Bhakts-Mac-mini-2)   │ │ (Backup / Peer)       │
                 │ Port 3000 (LaunchAgent│ │ Port 3000 (NSSM)      │
                 └───────────┬───────────┘ └───────────┬───────────┘
                             │                         │
                             └───────────┬─────────────┘
                                         ▼
                             RTSP Feeds (192.168.29.x)
```

- **Zero Downtime:** If either computer is turned off, sleeps, reboots, or updates, the other node instantly and automatically handles 100% of the stream traffic.
- **Git Auto-Sync:** Both servers automatically check for GitHub repository updates every 60 seconds and hot-reload.

---

## Features
- **Custom WebSocket streaming engine** — FFmpeg spawned per viewer, zero-copy MPEG1 video piped to browser via WebSocket
- **JSMpeg canvas player** — ~200ms ultra-low latency playback in any browser, no plugins
- **Digital Zoom & Pan** — Multi-touch pinch-to-zoom on phone, mouse wheel zoom on PC, drag to pan, and double-tap zoom
- **On-Demand Recording** — Direct stream copy recording stored in secret hidden vault (`.vault/`) with auto-purge upon download
- **Screen Keep-Awake** — Screen Wake Lock API prevents display timeout while streaming
- **Android / iOS PWA** — Install directly to home screen for full-screen native experience
- **JWT Authentication** — Session-based login with secure 30-day persistent cookie
- **Dynamic Feed Management** — Add, edit, rename, or reorder feeds dynamically from the UI
- **Auto-Failover Cloudflare Tunnel** — Seamless global access without port forwarding or static IP

---

## Quick Setup (Windows PC as Backup Server)

Open **PowerShell as Administrator** and run:

```powershell
# 1. Clone repository (or pull latest)
git clone https://github.com/Aarav-47/streaming-service.git C:\streaming-service
cd C:\streaming-service

# 2. Run automated installer (auto-configures FFmpeg, NSSM, feeds, and Cloudflare Tunnel)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install-windows.ps1
```

This single command automatically:
1. Checks & installs Node.js if missing
2. Downloads and configures FFmpeg
3. Installs `npm` dependencies
4. Verifies `feeds.json` with all 23 live feeds
5. Registers & starts `StreamingService` as a 24/7 background Windows Service (auto-start on boot)
6. Installs & connects `cloudflared` Windows Service with the failover tunnel token
7. Configures Windows Firewall for port 3000

---

## Quick Setup (macOS Server)

Open **Terminal** on macOS and run:

```bash
cd ~/Downloads
git clone https://github.com/Aarav-47/streaming-service.git
cd streaming-service
chmod +x install-macos.sh setup-feeds.sh
./install-macos.sh "eyJhIjoiZjE2MWM4MWExOTkzYmFiZDg2MDk1NGMyYWZlODZhYmQiLCJ0IjoiMmM4NjM3Y2YtYjlhNy00ZGI3LTkyOWYtZTU1MTJjZGQ2NmMyIiwicyI6IllUazVZakptWVdJdFl6RXlOQzAwTWpZNExXSTNNR0V0TldJNFltVTJPREF4TldNeiJ9"
```

---

## Windows Service Management

```powershell
# Check service status
Get-Service StreamingService, cloudflared

# Restart service
Restart-Service StreamingService

# View live service logs
Get-Content .\logs\service.log -Tail 50 -Wait

# Uninstall services (if needed)
.\uninstall-windows.ps1
```

---

## Credentials
- **Public Domain:** `https://aa.horizonhuedigital.in`
- **Local Dashboard:** `http://localhost:3000`
- **Username:** `admin`
- **Password:** `Aarav@2000`

---

## License
MIT © Horizon Hue Digital
