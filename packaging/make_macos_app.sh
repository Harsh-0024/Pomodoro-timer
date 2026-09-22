#!/usr/bin/env bash
# Build "Muhurata Timer.app" — a proper Mac app bundle (real name, real icon)
# that opens the timer. Called by install.sh; safe to run again to rebuild.
#
#   packaging/make_macos_app.sh <install-dir> <output-dir>
set -euo pipefail

INSTALL_DIR="${1:?install dir required}"
OUT_DIR="${2:?output dir required}"
APP="$OUT_DIR/Muhurata Timer.app"
VERSION="$(sed -n 's/.*"\(.*\)".*/\1/p' "$INSTALL_DIR/version.py" 2>/dev/null || echo 1.0.0)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The bundle's executable opens a Terminal window running the launcher. The
# window is deliberate: it shows "running at http://..." and closing it (or
# Ctrl+C) is how you stop the timer.
cat > "$APP/Contents/MacOS/muhurata" <<LAUNCH
#!/bin/bash
exec /usr/bin/open -a Terminal "$INSTALL_DIR/Muhurata Timer.command"
LAUNCH
chmod +x "$APP/Contents/MacOS/muhurata"

cp "$INSTALL_DIR/packaging/icon.icns" "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Muhurata Timer</string>
  <key>CFBundleDisplayName</key><string>Muhurata Timer</string>
  <key>CFBundleIdentifier</key><string>com.muhurata.timer.launcher</string>
  <key>CFBundleExecutable</key><string>muhurata</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict>
</plist>
PLIST

# Nudge Finder to pick up the new icon straight away.
touch "$APP"
