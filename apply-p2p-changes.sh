#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-.}"
if [[ ! -d "$TARGET/.git" ]]; then
  echo "Ошибка: $TARGET не является корнем Git-репозитория." >&2
  exit 1
fi
cp -a "$SCRIPT_DIR/payload/." "$TARGET/"
while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  rm -rf "$TARGET/$file"
done < "$SCRIPT_DIR/DELETED_FILES.txt"
echo "Файлы применены. Проверьте: git status && npm test"
