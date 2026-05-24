FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /out/downloader ./cmd/downloader

FROM alpine:3.20
RUN apk add --no-cache yt-dlp ffmpeg ca-certificates
COPY --from=build /out/downloader /usr/local/bin/downloader
WORKDIR /
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/downloader"]
