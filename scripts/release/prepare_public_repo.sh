#!/usr/bin/env bash
set -euo pipefail

# Prepare a minimal, public-safe repo snapshot under ./public-release
# Includes brand guidelines and a few small example card images.
# Excludes scanning/inference code, internal runbooks, creds, and heavy assets.

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

TARGET_DIR="$ROOT_DIR/public-release"

if [[ -e "$TARGET_DIR" ]] && [[ -n "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]]; then
  echo "Refusing to overwrite non-empty $TARGET_DIR. Remove it or choose a different path." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR/brand" "$TARGET_DIR/examples/cards"

# 1) Copy brand assets (safe/public-facing)
safe_copy() {
  local src="$1"
  local dest="$2"
  if [[ -f "$src" ]]; then
    cp -v "$src" "$dest" >/dev/null 2>&1 || cp -v "$src" "$dest"
  fi
}

safe_copy "brand/cardmint-brand-pillars.md" "$TARGET_DIR/brand/"
safe_copy "brand/cardmintpallet.json" "$TARGET_DIR/brand/"
safe_copy "brand/palette.png" "$TARGET_DIR/brand/"
safe_copy "brand/favicon.ico" "$TARGET_DIR/brand/"
safe_copy "brand/favicon-16x16.png" "$TARGET_DIR/brand/"
safe_copy "brand/favicon-32x32.png" "$TARGET_DIR/brand/"
safe_copy "brand/apple-touch-icon.png" "$TARGET_DIR/brand/"
safe_copy "brand/android-chrome-192x192.png" "$TARGET_DIR/brand/"
safe_copy "brand/android-chrome-512x512.png" "$TARGET_DIR/brand/"
safe_copy "brand/site.webmanifest" "$TARGET_DIR/brand/"

# 2) Select a handful of the smallest example card images
echo "Selecting up to 6 smallest images from ./pokemoncards into ./public-release/examples/cards" >&2
if [[ -d "pokemoncards" ]]; then
  # Supports png/jpg/jpeg; prefer small files to avoid bloat
  # Using GNU find -printf; if unavailable, fallback to ls sort
  if command -v find >/dev/null 2>&1; then
    mapfile -t SMALL_IMAGES < <(find pokemoncards -type f \( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" \) -printf '%s\t%p\n' 2>/dev/null | sort -n | head -n 6 | awk '{print $2}')
  fi
  if [[ ${#SMALL_IMAGES[@]} -eq 0 ]]; then
    # Fallback
    mapfile -t SMALL_IMAGES < <(ls -1S pokemoncards/*.{png,jpg,jpeg} 2>/dev/null | tail -n 6)
  fi
  for img in "${SMALL_IMAGES[@]:-}"; do
    [[ -f "$img" ]] || continue
    cp -v "$img" "$TARGET_DIR/examples/cards/"
  done
else
  echo "Note: ./pokemoncards not found; skipping example image copy." >&2
fi

# 3) Create a minimal README for the public repo
cat > "$TARGET_DIR/README.md" << 'EOF'
# CardMint Public Brand Kit

This repository contains CardMint's public-facing brand guidelines and a few lightweight example card images for design and theming work.

Included:
- brand/cardmint-brand-pillars.md (canonical brand strategy)
- brand/cardmintpallet.json and palette.png (verified palette)
- brand favicons and manifest
- examples/cards/ (a handful of small images for demos only)

Not included (by design):
- Scanning/inference code, internal operator tooling, private runbooks
- Production credentials, environment files, or infrastructure details
- Full image corpus (to avoid repo bloat)

Getting Started:
1) Use the brand palette and pillars as the foundation for theming.
2) Treat example images as placeholders for design previews only.

Publish (manual steps):
```bash
cd public-release
git init
git add .
git commit -m "chore(public): initial CardMint brand kit"
# Create an empty repo on GitHub first, then:
git remote add origin git@github.com:<your-org>/cardmint-brand-kit.git
git push -u origin main
```

Questions: open an issue in the GitHub repo or contact the CardMint team.
EOF

# 4) Add a public-safe .gitignore to keep the repo tidy
cat > "$TARGET_DIR/.gitignore" << 'EOF'
# General
.DS_Store
Thumbs.db
*.log

# Node/build leftovers (if you add demos)
node_modules/
dist/
.dist/
coverage/

# OS/editor files
.idea/
.vscode/
EOF

echo "Public release prepared at: $TARGET_DIR" >&2
echo "Review contents, then initialize a new git repo inside public-release and push." >&2

# Normalize file permissions for collaboration (text/images 664)
find "$TARGET_DIR" -type f -exec chmod 664 {} + 2>/dev/null || true
