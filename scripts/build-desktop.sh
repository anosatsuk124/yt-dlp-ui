#!/usr/bin/env bash
# Assemble every input the Tauri bundler needs, then build the desktop app for
# one target. Run on a native runner per OS/arch (better-sqlite3 + the Go binary
# + the tools must all match the target).
#
#   OS=linux|macos|windows  ARCH=x64|arm64  TRIPLE=<rust-triple>  [TAURI_ARGS=...]
# Defaults to the host.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="${OS:-linux}"
ARCH="${ARCH:-x64}"
TRIPLE="${TRIPLE:-$(rustc -vV | sed -n 's/host: //p')}"
exe=""; [ "$OS" = windows ] && exe=".exe"

case "$OS" in linux) GOOS=linux ;; macos) GOOS=darwin ;; windows) GOOS=windows ;; esac
case "$ARCH" in x64) GOARCH=amd64 ;; arm64) GOARCH=arm64 ;; esac

WEB="$ROOT/src-tauri/resources/web"
BIN="$ROOT/src-tauri/resources/bin"
BINARIES="$ROOT/src-tauri/binaries"
mkdir -p "$WEB" "$BIN" "$BINARIES"

echo "== [1/5] build web (next + esbuild server) =="
( cd "$ROOT/web" && npm ci && npm run build && node scripts/build-server.mjs "$WEB/server.js" )

echo "== [2/5] assemble resources/web (prod tree) =="
rm -rf "$WEB/.next" "$WEB/node_modules"
cp -r "$ROOT/web/.next" "$WEB/.next"
cp "$ROOT/web/next.config.mjs" "$ROOT/web/schema.sql" "$ROOT/web/package.json" "$ROOT/web/package-lock.json" "$WEB/"
( cd "$WEB" && npm ci --omit=dev )   # production node_modules incl. native better-sqlite3
# Drop musl-libc native bindings (Next.js SWC, sharp, …) npm pulls in alongside
# the glibc ones. The AppImage links glibc and never loads them, but linuxdeploy
# walks every ELF in the AppDir and aborts when it can't resolve their musl libc
# ("ERROR: Could not find dependency: libc.musl-x86_64.so.1"), failing the build.
if [ "$OS" = linux ]; then
  find "$WEB/node_modules" -type d -name '*musl*' -prune -exec rm -rf {} + 2>/dev/null || true
fi

echo "== [3/5] fetch bundled tools (yt-dlp, ffmpeg, ffprobe, node) =="
bash "$ROOT/scripts/fetch-tools.sh" "$OS" "$ARCH" "$BIN"

echo "== [4/5] sidecar binaries (downloader + node) =="
( cd "$ROOT/downloader" && CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
    go build -ldflags="-s -w" -o "$BINARIES/downloader-$TRIPLE$exe" ./cmd/downloader )
cp "$BIN/node$exe" "$BINARIES/node-$TRIPLE$exe"

if [ "${SKIP_TAURI_BUILD:-0}" = "1" ]; then
  echo "== inputs assembled; skipping tauri build (CI delegates to tauri-action) =="
  exit 0
fi

echo "== [5/5] tauri build =="
( cd "$ROOT/src-tauri" && cargo tauri build --target "$TRIPLE" ${TAURI_ARGS:-} )

echo "done."
