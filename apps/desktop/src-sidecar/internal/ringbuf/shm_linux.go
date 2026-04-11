//go:build linux

package ringbuf

import "fmt"

// Attach is not yet implemented on Linux. See ADR 18 (revised 2026-04-11):
// Linux will use memfd_create + fd passing via a subsequent ticket.
func Attach(_ uintptr, _ int) ([]byte, func(), error) {
	return nil, nil, fmt.Errorf("ring buffer attach not yet supported on linux")
}

// Notify is not yet implemented on Linux. The Linux port will use eventfd
// instead of a Windows Event.
func Notify(_ uintptr) error {
	return fmt.Errorf("ring buffer notify not yet supported on linux")
}

// CloseEventHandle is a no-op on Linux until the eventfd implementation lands.
func CloseEventHandle(_ uintptr) error {
	return nil
}
