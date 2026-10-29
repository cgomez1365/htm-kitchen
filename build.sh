#!/bin/bash
# Builds Hope Kitchen.app into ./build. Usage: ./build.sh [--test]
set -euo pipefail
export CLANG_MODULE_CACHE_PATH="$(cd "$(dirname "$0")" && pwd)/build/.modcache"
cd "$(dirname "$0")"
APP="build/Hope Kitchen.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
xcrun swiftc -O -swift-version 5 -module-cache-path build/.modcache \
  -target "$(uname -m)-apple-macos13.0" \
  -framework AppKit -framework WebKit -framework AVFoundation -framework Vision -framework CoreImage -lsqlite3 \
  Sources/*.swift -o "$APP/Contents/MacOS/HopeKitchen"
cp Resources/Info.plist "$APP/Contents/"
cp -R UI "$APP/Contents/Resources/UI"
[ -f Resources/AppIcon.icns ] && cp Resources/AppIcon.icns "$APP/Contents/Resources/"
codesign --force --sign - --entitlements Resources/HopeKitchen.entitlements "$APP" >/dev/null
echo "built: $APP"
if [ "${1:-}" = "--test" ]; then "$APP/Contents/MacOS/HopeKitchen" --selftest; fi
