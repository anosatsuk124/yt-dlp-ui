FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/downloader ./cmd/downloader

FROM alpine:3.20

# Alpine's apk-packaged yt-dlp lags behind upstream by months and has been
# observed missing metadata (e.g. Twitch titles) that the latest release
# fetches correctly. Install from PyPI instead so the extractor stays
# current. Pin via build arg so the cache can be busted on demand.
ARG YTDLP_VERSION=2026.03.17
# Optional yt-dlp deps:
#   websockets    — nicovideo live (nicolive) start signal, twitch chat, etc.
#   pycryptodomex — native AES-128 segment decryption. Without it yt-dlp
#                   delegates HLS to ffmpeg, which refetches segments with
#                   plain curl-equivalents and loses the auth/session token
#                   (observed as ffmpeg exit 183 / HTTP 403 on AbemaTV).
RUN apk add --no-cache ffmpeg ca-certificates python3 py3-pip && \
    pip install --no-cache-dir --break-system-packages \
        "yt-dlp==${YTDLP_VERSION}" \
        websockets \
        pycryptodomex

COPY --from=build /out/downloader /usr/local/bin/downloader
WORKDIR /
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/downloader"]
