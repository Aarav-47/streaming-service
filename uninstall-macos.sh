#!/usr/bin/env bash
PLIST_PATH="$HOME/Library/LaunchAgents/com.streamingservice.app.plist"

echo "Stopping Streaming Service on macOS..."
if [[ -f "$PLIST_PATH" ]]; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "[OK] LaunchAgent removed."
fi

if command -v cloudflared &>/dev/null; then
  echo "To uninstall cloudflared service (if needed):"
  echo "   sudo cloudflared service uninstall"
fi

echo "Done."
