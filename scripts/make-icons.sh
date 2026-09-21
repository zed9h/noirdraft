#!/usr/bin/env bash
# Generates NoirDraft's Electron window icon from the canonical icon.png at
# the repository root. The generated asset is committed so a packaged app has
# the same icon without depending on files outside its application source.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ICON="$ROOT/icon.png"
OUTPUT_DIR="$ROOT/src/main/assets"
OUTPUT_ICON="$OUTPUT_DIR/icon.png"

if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Error: source icon not found: $SOURCE_ICON" >&2
  exit 1
fi

if command -v magick >/dev/null 2>&1; then
  image_magick=(magick)
elif command -v convert >/dev/null 2>&1; then
  image_magick=(convert)
else
  echo "Error: ImageMagick is required (install the 'imagemagick' package)." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
"${image_magick[@]}" "$SOURCE_ICON" -resize '512x512' -strip "$OUTPUT_ICON"

echo "Generated src/main/assets/icon.png from icon.png."
