//go:build windows

package ringbuf

import (
	"fmt"
	"reflect"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const fileMapAllAccess = 0xF001F

var (
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	procOpenFileMapping = kernel32.NewProc("OpenFileMappingW")
)

// OpenShared opens a named shared memory region created by the Rust host.
func OpenShared(name string, size int) ([]byte, func(), error) {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid shm name: %w", err)
	}

	r1, _, e1 := procOpenFileMapping.Call(
		uintptr(fileMapAllAccess),
		0, // bInheritHandle = false
		uintptr(unsafe.Pointer(namePtr)),
	)
	if r1 == 0 {
		return nil, nil, fmt.Errorf("OpenFileMappingW(%s): %w", name, e1)
	}
	handle := windows.Handle(r1)

	addr, err := windows.MapViewOfFile(handle, fileMapAllAccess, 0, 0, uintptr(size))
	if err != nil {
		windows.CloseHandle(handle)
		return nil, nil, fmt.Errorf("MapViewOfFile: %w", err)
	}

	// Convert MapViewOfFile result to a byte slice.
	// This uses reflect.SliceHeader which is the standard pattern
	// for go vet compliance when working with memory-mapped regions.
	var mem []byte
	sh := (*reflect.SliceHeader)(unsafe.Pointer(&mem))
	sh.Data = addr
	sh.Len = size
	sh.Cap = size

	cleanup := func() {
		windows.UnmapViewOfFile(addr)
		windows.CloseHandle(handle)
	}

	return mem, cleanup, nil
}
