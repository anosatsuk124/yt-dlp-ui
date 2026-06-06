//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// sysProcAttr puts each yt-dlp invocation in its own process group so we can
// signal the whole tree (yt-dlp + any spawned ffmpeg/node child) at once.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// sendSignal delivers sig to the job's process group (negative PID), falling
// back to the single process if the group send fails.
func sendSignal(cmd *exec.Cmd, sig syscall.Signal) error {
	if cmd.Process == nil {
		return nil
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); err == nil {
		return nil
	}
	return cmd.Process.Signal(sig)
}
