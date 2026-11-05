#!/bin/bash
# Build the GoldTerm site image from a release tag:  bash docker/build-v1.sh [tag]   (default v1.1.1)
# Only the 5 published site files are taken from git, so forward/ and journal-sync.* can never get in.
set -euo pipefail
TAG=${1:-v1.1.1}; VER=${TAG#v}
REPO=$(cd "$(dirname "$0")/.." && pwd)
CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/site"
git -C "$REPO" -c core.autocrlf=false archive "$TAG" index.html app.js strategies.js styles.css levels.js | tar -x -C "$CTX/site"
cp "$REPO/docker/Dockerfile" "$REPO/docker/nginx.conf" "$CTX/"
grep -q "?v=$VER" "$CTX/site/index.html" || { echo "index.html in $TAG is not stamped ?v=$VER"; exit 1; }
docker build --build-arg GOLDTERM_VERSION="$VER" -t "goldterm-site:$VER" "$(cygpath -m "$CTX" 2>/dev/null || echo "$CTX")"
echo "built goldterm-site:$VER   run:  docker run -d --name goldterm-v1 -p 8088:8080 goldterm-site:$VER"
