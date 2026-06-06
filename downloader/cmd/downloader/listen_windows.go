//go:build windows

package main

import (
	"net"

	"github.com/Microsoft/go-winio"
)

// listenSocket binds a Windows named pipe at path (e.g. \\.\pipe\name). On
// Windows the Next.js sidecar and the Rust proxy both speak named pipes
// (Node has no AF_UNIX support there), so the downloader matches.
func listenSocket(path string) (net.Listener, error) {
	return winio.ListenPipe(path, nil)
}
