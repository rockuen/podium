#!/bin/bash
# Build .vsix package for CLI Launcher for Claude
# Usage: bash build.sh [--publish]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== CLI Launcher for Claude — Build ==="

# Check tools
if ! command -v npx &>/dev/null; then
  echo "Error: npx not found. Install Node.js first."
  exit 1
fi

# Install vsce if needed
if ! npx vsce --version &>/dev/null 2>&1; then
  echo "Installing @vscode/vsce..."
  npm install -g @vscode/vsce
fi

# Clean previous builds
rm -f *.vsix

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

# Rebuild node-pty for current platform
echo "Rebuilding node-pty for current platform..."
npx electron-rebuild -m . 2>/dev/null || npm rebuild node-pty 2>/dev/null || true

# Detect platform
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM="win32-x64" ;;
  Darwin)
    if [ "$(uname -m)" = "arm64" ]; then
      PLATFORM="darwin-arm64"
    else
      PLATFORM="darwin-x64"
    fi
    ;;
  Linux) PLATFORM="linux-x64" ;;
  *) PLATFORM="universal" ;;
esac

echo "Platform: $PLATFORM"

# Package
echo "Packaging .vsix..."
npx vsce package --target "$PLATFORM" --no-git-tag-version --allow-missing-repository

VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -1)
if [ -z "$VSIX_FILE" ]; then
  echo "Error: .vsix file not created"
  exit 1
fi

echo ""
echo "Build complete: $VSIX_FILE"
echo ""

# Publish if requested
if [ "$1" = "--publish" ]; then
  if ! command -v npx ovsx &>/dev/null; then
    echo "Installing ovsx..."
    npm install -g ovsx
  fi

  read -p "Open VSX token: " OVSX_TOKEN
  echo "Publishing to Open VSX..."
  npx ovsx publish "$VSIX_FILE" -p "$OVSX_TOKEN"
  echo "Published!"
else
  echo "To publish: bash build.sh --publish"
  echo "Or manually: npx ovsx publish $VSIX_FILE -p <token>"
fi
