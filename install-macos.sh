#!/usr/bin/env bash
set -e

echo "══════════════════════════════════════════════════════════════"
echo "   Streaming Service — macOS Automated Backup Server Setup"
echo "══════════════════════════════════════════════════════════════"

# 1. Determine script directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

# 2. Check / Install Homebrew
if ! command -v brew &>/dev/null; then
  echo "[1/5] Homebrew not found. Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
else
  echo "[1/5] Homebrew is already installed."
fi

# 3. Install Node.js, FFmpeg, and cloudflared
echo "[2/5] Checking packages (node, ffmpeg, cloudflared)..."
for pkg in node ffmpeg cloudflared; do
  if ! command -v "$pkg" &>/dev/null; then
    echo "  -> Installing $pkg via brew..."
    brew install "$pkg"
  else
    echo "  -> $pkg is already installed."
  fi
done

NODE_BIN="$(which node)"
FFMPEG_BIN="$(which ffmpeg)"
CLOUDFLARED_BIN="$(which cloudflared)"
BREW_PREFIX="$(brew --prefix)"

echo "  - Node:        $NODE_BIN"
echo "  - FFmpeg:      $FFMPEG_BIN"
echo "  - Cloudflared: $CLOUDFLARED_BIN"

# 4. Install npm dependencies & setup feeds
echo "[3/5] Installing npm dependencies..."
npm install --omit=dev

if [[ ! -f "$DIR/feeds.json" ]]; then
  echo "  -> Generating initial feeds.json configuration..."
  "$DIR/setup-feeds.sh"
fi

# 5. Create logs directory
mkdir -p "$DIR/logs"

# 6. Configure macOS LaunchAgent (auto-runs on boot, auto-restarts on crash)
echo "[4/5] Setting up macOS LaunchAgent for Streaming Service..."
PLIST_PATH="$HOME/Library/LaunchAgents/com.streamingservice.app.plist"
mkdir -p "$HOME/Library/LaunchAgents"

cat << PLIST > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.streamingservice.app</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DIR/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$DIR/logs/service.log</string>
    <key>StandardErrorPath</key>
    <string>$DIR/logs/service-err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>3000</string>
        <key>ADMIN_USER</key>
        <string>admin</string>
        <key>ADMIN_PASS</key>
        <string>Aarav@2000</string>
        <key>PATH</key>
        <string>$BREW_PREFIX/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"
echo "  [OK] Streaming Service LaunchAgent active on port 3000."

# 7. Cloudflare Tunnel Failover Connector Setup
echo "[5/5] Cloudflare Tunnel Failover Setup..."
TUNNEL_TOKEN="$1"

if [[ -z "$TUNNEL_TOKEN" ]]; then
  echo ""
  echo "---------------------------------------------------------------"
  echo " To enable automatic failover when your main Windows server is off:"
  echo " Run this command on your Windows PC (in PowerShell) to get your tunnel token:"
  echo "    cloudflared tunnel token streams"
  echo ""
  echo " Then run the following command on this Mac Mini:"
  echo "    sudo cloudflared service install <PASTE_TOKEN_HERE>"
  echo "---------------------------------------------------------------"
else
  echo "  -> Installing cloudflared service with provided token..."
  sudo cloudflared service install "$TUNNEL_TOKEN"
  echo "  [OK] Cloudflare Tunnel connector installed and active!"
fi

echo ""
echo "✅ Setup Complete!"
echo "• Local Dashboard:   http://localhost:3000"
echo "• Live Public URL:   https://aa.horizonhuedigital.in"
echo "• Service Logs:      $DIR/logs/service.log"
echo "══════════════════════════════════════════════════════════════"
