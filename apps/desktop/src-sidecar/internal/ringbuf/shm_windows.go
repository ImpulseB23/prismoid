//go:build windows

package ringbuf

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

const fileMapAllAccess = 0xF001F

// Attach maps a shared memory section that was created by the parent Rust host
// and inherited into this process via CreateProcess handle inheritance. The
// parent passes the raw handle value via the stdio bootstrap; this function
// takes ownership of that handle and closes it in the returned cleanup.
//
// The returned slice is backed by the mapped section. Writes are visible to
// any other process that has mapped the same section. The caller must call
// the returned cleanup exactly once when the section is no longer needed.
func Attach(handle uintptr, size int) ([]byte, func(), error) {
	if size <= 0 {
		return nil, nil, fmt.Errorf("invalid size %d", size)
	}
	if handle == 0 {
		return nil, nil, fmt.Errorf("invalid handle 0")
	}

	h := windows.Handle(handle)

	addr, err := windows.MapViewOfFile(h, fileMapAllAccess, 0, 0, uintptr(size))
	if err != nil {
		_ = windows.CloseHandle(h)
		return nil, nil, fmt.Errorf("MapViewOfFile: %w", err)
	}

	mem := unsafe.Slice((*byte)(unsafe.Pointer(addr)), size)

	cleanup := func() {
		_ = windows.UnmapViewOfFile(addr)
		_ = windows.CloseHandle(h)
	}

	return mem, cleanup, nil
}

// Notify signals the auto-reset Windows Event owned by the Rust host. Called
// by the writer goroutine after each successful ring buffer write so the host
// can wake from WaitForSingleObject immediately instead of polling on a timer.
// The host's WaitForSingleObject acts as a full memory barrier on its side,
// and the atomic.StoreUint64 of the write index inside `Writer.Write` already
// acts as a release store on this side, so no extra fence is required here.
func Notify(eventHandle uintptr) error {
	if eventHandle == 0 {
		return fmt.Errorf("invalid event handle 0")
	}
	if err := windows.SetEvent(windows.Handle(eventHandle)); err != nil {
		return fmt.Errorf("SetEvent: %w", err)
	}
	return nil
}

// CloseEventHandle releases the inherited event HANDLE on shutdown. Called
// from sidecar cleanup alongside the ring buffer cleanup. Separate from
// Attach's cleanup because the event handle lifetime is independent of the
// ring mapping.
func CloseEventHandle(eventHandle uintptr) error {
	if eventHandle == 0 {
		return nil
	}
	if err := windows.CloseHandle(windows.Handle(eventHandle)); err != nil {
		return fmt.Errorf("CloseHandle event: %w", err)
	}
	return nil
}
