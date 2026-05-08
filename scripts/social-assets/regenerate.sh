#!/usr/bin/env bash
set -euo pipefail

# Regenera apple-touch-icon.png (180x180) e og-image.png (1200x630)
# a partir das fontes em scripts/social-assets/.
# Saída: public/apple-touch-icon.png e public/og-image.png

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$REPO_ROOT/scripts/social-assets"
OUT_DIR="$REPO_ROOT/public"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

echo "→ Apple touch icon (180x180) via qlmanage..."
qlmanage -t -s 180 -o "$OUT_DIR" "$SRC_DIR/apple-touch-icon.svg" >/dev/null
mv "$OUT_DIR/apple-touch-icon.svg.png" "$OUT_DIR/apple-touch-icon.png"

echo "→ OG image (1200x630) via Chrome headless..."
"$CHROME" \
  --headless=new \
  --disable-gpu \
  --hide-scrollbars \
  --window-size=1200,630 \
  --screenshot="$OUT_DIR/og-image.png" \
  "file://$SRC_DIR/og-image.html" 2>/dev/null

echo "✓ Done."
ls -la "$OUT_DIR/apple-touch-icon.png" "$OUT_DIR/og-image.png"
