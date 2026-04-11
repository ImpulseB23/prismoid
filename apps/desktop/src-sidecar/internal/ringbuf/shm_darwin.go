//go:build darwin

package ringbuf

import "fmt"

// Attach is not yet implemented on macOS. See ADR 18 (revised 2026-04-11):
// macOS will use shm_open + coordinated unlink in a subsequent ticket.
func Attach(_ uintptr, _ int) ([]byte, func(), error) {
	return nil, nil, fmt.Errorf("ring buffer attach not yet supported on darwin")
}
