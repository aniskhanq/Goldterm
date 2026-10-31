#!/bin/bash
# Installs the newest GitHub Release of the site on this server. Run by goldterm-deploy.timer.
# Never touches the bot, /trades.json or any other file in the web root.
set -euo pipefail

REPO=${GOLDTERM_REPO:-aniskhanq/Goldterm}
WEB=${GOLDTERM_WEB:-/usr/share/nginx/html}
STATE=${GOLDTERM_STATE:-/var/lib/goldterm-deploy}
BACKUPS=${GOLDTERM_BACKUPS:-/var/backups}
SMOKE_URL=${GOLDTERM_SMOKE_URL:-http://127.0.0.1/}
FILES="index.html app.js strategies.js styles.css levels.js"

mkdir -p "$STATE"
tag=$(curl -fsS --max-time 30 "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/^ *"tag_name": *"\(.*\)",*$/\1/p')
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "no usable release tag: '$tag'"; exit 1; }
[ "$(cat "$STATE/current" 2>/dev/null || true)" != "$tag" ] || exit 0
[ "$(cat "$STATE/failed" 2>/dev/null || true)" != "$tag" ] || { echo "$tag already failed, waiting for a newer release"; exit 0; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cd "$work"
base="https://github.com/$REPO/releases/download/$tag"
curl -fsSL --max-time 120 -o site.tar.gz "$base/site.tar.gz"
curl -fsSL --max-time 30 -o SHA256SUMS "$base/SHA256SUMS"
sha256sum -c SHA256SUMS

want=$(tr ' ' '\n' <<<"$FILES" | sort)
[ "$(tar -tzf site.tar.gz | sort)" = "$want" ] || { echo "$tag: bundle does not hold exactly the site files"; exit 1; }
mkdir site; tar -xzf site.tar.gz -C site --no-same-owner --no-same-permissions

backup="$BACKUPS/goldterm-$(date -u +%Y%m%d-%H%M%S)-$tag"
mkdir -p "$backup"
for f in $FILES; do [ ! -e "$WEB/$f" ] || cp -p "$WEB/$f" "$backup/"; done

put() { for f in $FILES; do [ ! -e "$1/$f" ] || install -m 644 "$1/$f" "$WEB/$f"; done; }
put site
if curl -fsS --max-time 15 "$SMOKE_URL" | grep -qF "?v=${tag#v}"; then
  echo "$tag" > "$STATE/current"
  rm -f "$STATE/failed"
  echo "deployed $tag (backup $backup)"
else
  put "$backup"
  echo "$tag" > "$STATE/failed"
  echo "$tag failed the smoke test, restored $backup"
  exit 1
fi
ls -1dt "$BACKUPS"/goldterm-* 2>/dev/null | tail -n +11 | xargs -r rm -rf
