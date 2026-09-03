#!/bin/bash
# Take a Meep - build the macOS app and install it on the Desktop.
set -e
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "❌ npm not found - install Node.js first"; exit 1
fi
cd "$(dirname "$0")"
echo "==> Rebuilding the app icon"
npm run icon
echo "==> Packaging Take a Meep.app"
npm run package:mac
echo "==> Quitting the running copy (if any)"
pkill -x "Take a Meep" 2>/dev/null && sleep 1 || true
pkill -x "Meep Bird" 2>/dev/null && sleep 1 || true
echo "==> Installing to the Desktop"
rm -rf "$HOME/Desktop/Take a Meep.app"
rm -rf "$HOME/Desktop/Meep Bird.app"
ditto "dist/Take a Meep-darwin-arm64/Take a Meep.app" "$HOME/Desktop/Take a Meep.app"
echo "==> Launching"
open "$HOME/Desktop/Take a Meep.app"
echo ""
echo "✅ Done: Take a Meep.app is on the Desktop and running (the old Meep Bird.app was replaced). Double-click this file again after future changes."
