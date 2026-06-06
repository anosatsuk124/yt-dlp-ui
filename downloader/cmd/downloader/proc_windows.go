//go:build windows

package main

import (
	"os/exec"
	"strconv"
	"syscall"
)

// ctrlBreakEvent is CTRL_BREAK_EVENT for GenerateConsoleCtrlEvent. The stdlib
// syscall package does not export the constant, so define it locally.
const ctrlBreakEvent = 1

// sysProcAttr starts yt-dlp in a new process group so a CTRL_BREAK can be
// delivered to the whole group (yt-dlp + its ffmpeg/node children).
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// sendSignal approximates the Unix process-group signalling on Windows.
// SIGKILL maps to a forced tree termination (taskkill /T /F); a graceful
// signal maps to CTRL_BREAK on the process group, with taskkill as fallback.
func sendSignal(cmd *exec.Cmd, sig syscall.Signal) error {
	if cmd.Process == nil {
		return nil
	}
	pid := cmd.Process.Pid
	if sig == syscall.SIGKILL {
		_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
		return cmd.Process.Kill()
	}
	if err := sendCtrlBreak(pid); err == nil {
		return nil
	}
	_ = exec.Command("taskkill", "/T", "/PID", strconv.Itoa(pid)).Run()
	return nil
}

func sendCtrlBreak(pid int) error {
	dll, err := syscall.LoadDLL("kernel32.dll")
	if err != nil {
		return err
	}
	defer dll.Release()
	proc, err := dll.FindProc("GenerateConsoleCtrlEvent")
	if err != nil {
		return err
	}
	if r, _, callErr := proc.Call(uintptr(ctrlBreakEvent), uintptr(pid)); r == 0 {
		return callErr
	}
	return nil
}
