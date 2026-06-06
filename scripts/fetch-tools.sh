#!/usr/bin/env bash
# Fetch and pin the bundled tools (yt-dlp, ffmpeg, ffprobe, node) for one target
# into <dest-dir>. The Go downloader's PATH is pointed at this dir at runtime, so
# yt-dlp finds ffmpeg/ffprobe and uses node as its JS runtime — no system installs.
#
# Usage: scripts/fetch-tools.sh <os> <arch> <dest-dir>
#   os:   linux | macos | windows
#   arch: x64 | arm64
#
# Pins are overridable via YTDLP_VERSION / NODE_VERSION / FFMPEG_BTBN_TAG env vars.
set -euo pipefail

OS="${1:?os (linux|macos|windows)}"
ARCH="${2:?arch (x64|arm64)}"
DEST="${3:?dest dir}"

YTDLP_VERSION="${YTDLP_VERSION:-2026.03.17}"
NODE_VERSION="${NODE_VERSION:-20.15.0}"
# BtbN ffmpeg static builds: "latest" is rolling; pin a dated autobuild tag in CI.
FFMPEG_BTBN_TAG="${FFMPEG_BTBN_TAG:-latest}"

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

dl() { curl -fL --retry 3 --retry-delay 2 -o "$2" "$1"; }
say() { printf '\n== %s ==\n' "$*"; }

exe="" ; [ "$OS" = windows ] && exe=".exe"

# --- yt-dlp (PyInstaller standalone: bundles python + pycryptodomex + websockets) ---
say "yt-dlp ${YTDLP_VERSION} (${OS}/${ARCH})"
case "${OS}-${ARCH}" in
  linux-x64)   YA=yt-dlp_linux ;;
  linux-arm64) YA=yt-dlp_linux_aarch64 ;;
  macos-x64|macos-arm64) YA=yt-dlp_macos ;;   # universal2
  windows-x64) YA=yt-dlp.exe ;;
  *) echo "unsupported ${OS}-${ARCH}" >&2; exit 2 ;;
esac
base="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}"
dl "${base}/${YA}" "ytdlp.bin"
dl "${base}/SHA2-256SUMS" sums.txt
want=$(grep -E "  ${YA}\$" sums.txt | awk '{print $1}')
got=$(sha256sum ytdlp.bin | awk '{print $1}')
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "yt-dlp checksum mismatch ($want != $got)"; exit 1; }
install -m 0755 ytdlp.bin "${DEST}/yt-dlp${exe}"

# --- node (the Next.js runtime, also yt-dlp's --js-runtimes node) ---
say "node ${NODE_VERSION}"
case "${OS}-${ARCH}" in
  linux-x64)   NP="node-v${NODE_VERSION}-linux-x64";    NE=tar.xz ;;
  linux-arm64) NP="node-v${NODE_VERSION}-linux-arm64";  NE=tar.xz ;;
  macos-x64)   NP="node-v${NODE_VERSION}-darwin-x64";   NE=tar.xz ;;
  macos-arm64) NP="node-v${NODE_VERSION}-darwin-arm64"; NE=tar.xz ;;
  windows-x64) NP="node-v${NODE_VERSION}-win-x64";      NE=zip ;;
esac
dl "https://nodejs.org/dist/v${NODE_VERSION}/${NP}.${NE}" "node.${NE}"
dl "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" node-sums.txt
nwant=$(grep -E "  ${NP}\.${NE}\$" node-sums.txt | awk '{print $1}')
ngot=$(sha256sum "node.${NE}" | awk '{print $1}')
[ -n "$nwant" ] && [ "$nwant" = "$ngot" ] || { echo "node checksum mismatch ($nwant != $ngot)"; exit 1; }
if [ "$NE" = "tar.xz" ]; then
  tar xf "node.${NE}"
  install -m 0755 "${NP}/bin/node" "${DEST}/node"
else
  unzip -q "node.${NE}"
  install -m 0755 "${NP}/node.exe" "${DEST}/node.exe"
fi

# --- ffmpeg + ffprobe (static) ---
say "ffmpeg + ffprobe"
case "$OS" in
  linux|windows)
    case "${OS}-${ARCH}" in
      linux-x64)   FA="ffmpeg-master-latest-linux64-gpl.tar.xz" ;;
      linux-arm64) FA="ffmpeg-master-latest-linuxarm64-gpl.tar.xz" ;;
      windows-x64) FA="ffmpeg-master-latest-win64-gpl.zip" ;;
    esac
    dl "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_BTBN_TAG}/${FA}" "ff.archive"
    if [ "$OS" = windows ]; then
      unzip -q ff.archive
      d=$(find . -maxdepth 1 -type d -name 'ffmpeg-*');
      install -m 0755 "$d/bin/ffmpeg.exe" "${DEST}/ffmpeg.exe"
      install -m 0755 "$d/bin/ffprobe.exe" "${DEST}/ffprobe.exe"
    else
      tar xf ff.archive
      d=$(find . -maxdepth 1 -type d -name 'ffmpeg-*')
      install -m 0755 "$d/bin/ffmpeg" "${DEST}/ffmpeg"
      install -m 0755 "$d/bin/ffprobe" "${DEST}/ffprobe"
    fi
    ;;
  macos)
    # evermeet provides notarized static Intel builds (run under Rosetta on arm).
    dl "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" ffmpeg.zip
    dl "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" ffprobe.zip
    unzip -q ffmpeg.zip && unzip -q ffprobe.zip
    install -m 0755 ffmpeg "${DEST}/ffmpeg"
    install -m 0755 ffprobe "${DEST}/ffprobe"
    ;;
esac

say "done -> ${DEST}"
ls -la "$DEST"
