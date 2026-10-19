#!/usr/bin/env bash
# Build "Muhurta Pomodoro.app" — a proper Mac app bundle (real name, real icon)
# that opens the timer. Called by install.sh; safe to run again to rebuild.
#
#   packaging/make_macos_app.sh <install-dir> <output-dir>
set -euo pipefail

INSTALL_DIR="${1:?install dir required}"
OUT_DIR="${2:?output dir required}"
APP="$OUT_DIR/Muhurta Pomodoro.app"
VERSION="$(sed -n 's/.*"\(.*\)".*/\1/p' "$INSTALL_DIR/version.py" 2>/dev/null || echo 1.0.0)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Bump with LAUNCHER_VERSION in run.py: an install whose app is older gets it
# rebuilt on its next start.
LAUNCHER_VERSION=3

# The bundle's executable starts the launcher in the background - no
# Terminal window. Closing the timer's window stops it; anything worth
# knowing goes to launcher.log, and problems appear in a pop-up.
cat > "$APP/Contents/MacOS/muhurata" <<LAUNCH
#!/bin/bash
cd "$INSTALL_DIR" || exit 1
exec "$INSTALL_DIR/.venv/bin/python" run.py </dev/null >/dev/null 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/muhurata"
echo "$LAUNCHER_VERSION" > "$APP/Contents/Resources/launcher-version"

cp "$INSTALL_DIR/packaging/icon.icns" "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Muhurta Pomodoro</string>
  <key>CFBundleDisplayName</key><string>Muhurta Pomodoro</string>
  <key>CFBundleIdentifier</key><string>com.muhurata.timer.launcher</string>
  <key>CFBundleExecutable</key><string>muhurata</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- No Dock icon of its own: the timer's window is the app, and the
       launcher underneath has no window for the Dock to show. -->
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
</dict>
</plist>
PLIST

# Nudge Finder to pick up the new icon straight away.
touch "$APP"
