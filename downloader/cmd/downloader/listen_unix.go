//go:build !windows

package main

import (
	"net"
	"os"
)

// listenSocket binds a Unix domain socket at path with 0600 perms, clearing a
// stale socket file first. Used by the desktop build (DOWNLOADER_SOCKET) so no
// TCP port is opened.
func listenSocket(path string) (net.Listener, error) {
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return ln, nil
}
