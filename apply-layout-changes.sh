#!/usr/bin/env bash
set -euo pipefail
TARGET="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$TARGET/components" "$TARGET/app"
cp "$SCRIPT_DIR/components/watch-room.tsx" "$TARGET/components/watch-room.tsx"
cp "$SCRIPT_DIR/components/video-player.tsx" "$TARGET/components/video-player.tsx"
cp "$SCRIPT_DIR/app/globals.css" "$TARGET/app/globals.css"
echo "Готово. Теперь запустите: pnpm test && pnpm typecheck && pnpm build"
