#!/bin/bash
# Claude Code Launcher - Install Script
# Usage: ./install.sh [vscode|antigravity]
#   기본값: vscode

set -e

PUBLISHER="rockuen"
NAME="claude-code-launcher"
VERSION="2.0.0"
EXT_ID="${PUBLISHER}.${NAME}-${VERSION}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "  Claude Code Launcher v${VERSION} Installer"
echo "  ========================================="
echo ""

# Detect platform
OS=$(uname -s)
case "$OS" in
  Darwin)  PLATFORM="mac" ;;
  Linux)   PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
  *) echo -e "${RED}  Unsupported platform: $OS${NC}"; exit 1 ;;
esac
echo -e "  Platform: ${GREEN}${PLATFORM}${NC}"

# Detect IDE (default: vscode)
IDE_TYPE="${1:-vscode}"

case "$IDE_TYPE" in
  vscode)
    EXT_DIR="$HOME/.vscode/extensions/${EXT_ID}"
    ;;
  antigravity)
    EXT_DIR="$HOME/.antigravity/extensions/${EXT_ID}"
    ;;
  *)
    echo -e "${RED}  Unknown IDE: $IDE_TYPE. Use 'vscode' or 'antigravity'${NC}"
    exit 1
    ;;
esac
echo -e "  IDE: ${GREEN}${IDE_TYPE}${NC}"
echo -e "  Install to: ${GREEN}${EXT_DIR}${NC}"
echo ""

# Step 1: Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "  ${RED}[1/4] Node.js not found. Please install Node.js 18+ first.${NC}"
  exit 1
fi
NODE_VER=$(node -v)
echo -e "  [1/4] Node.js: ${GREEN}${NODE_VER}${NC}"

# Step 2: Install dependencies & rebuild native modules
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "  [2/4] Installing dependencies (node-pty build)..."
npm install --production 2>&1 | tail -3
echo -e "  [2/4] ${GREEN}Dependencies ready${NC}"

# Step 3: Copy to extensions directory
echo -e "  [3/4] Copying to extensions directory..."
mkdir -p "$EXT_DIR/icons"

cp extension.js "$EXT_DIR/"
cp package.json "$EXT_DIR/"
cp -r icons/*.svg "$EXT_DIR/icons/"
cp -r node_modules "$EXT_DIR/"

echo -e "  [3/4] ${GREEN}Files copied${NC}"

# Step 4: Verify
FAIL=0
if [ ! -f "$EXT_DIR/extension.js" ]; then
  echo -e "  ${RED}  - extension.js missing${NC}"
  FAIL=1
fi
if [ ! -f "$EXT_DIR/package.json" ]; then
  echo -e "  ${RED}  - package.json missing${NC}"
  FAIL=1
fi
if [ ! -d "$EXT_DIR/node_modules/node-pty" ]; then
  echo -e "  ${RED}  - node-pty missing${NC}"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo -e "  [4/4] ${GREEN}Verification passed${NC}"
else
  echo -e "  [4/4] ${RED}Verification failed${NC}"
  exit 1
fi

echo ""
echo -e "  ${GREEN}Installation complete!${NC}"
echo ""
echo "  Next steps:"
echo "    1. IDE에서 Ctrl+Shift+P → 'Reload Window' 실행"
echo "    2. Ctrl+Shift+Enter 로 Claude Code 탭 열기"
echo ""
