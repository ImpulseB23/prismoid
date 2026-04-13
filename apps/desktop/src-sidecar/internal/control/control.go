package control

// Bootstrap is the first message the Rust host writes to the sidecar's stdin
// at startup. It hands over the inherited shared memory section so the sidecar
// can attach without having to know a name or open a kernel object by lookup.
//
// ShmEventHandle is an auto-reset Windows Event created by the host alongside
// the mapping. The writer goroutine calls SetEvent on it after each successful
// ring write so the host can wake from WaitForSingleObject immediately instead
// of polling on a timer.
type Bootstrap struct {
	ShmHandle      uintptr `json:"shm_handle"`
	ShmEventHandle uintptr `json:"shm_event_handle"`
	ShmSize        int     `json:"shm_size"`
}

// Command is a control-plane message from the Rust host received over stdin
// after the Bootstrap message. Each command targets a single platform client.
type Command struct {
	Cmd           string `json:"cmd"`
	Channel       string `json:"channel,omitempty"`
	Token         string `json:"token,omitempty"`
	ClientID      string `json:"client_id,omitempty"`
	BroadcasterID string `json:"broadcaster_id,omitempty"`
	UserID        string `json:"user_id,omitempty"`
}

// Message is a notification the sidecar writes to stdout for the Rust host.
type Message struct {
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
}

// HeartbeatPayload is the body of a `{"type":"heartbeat", ...}` Message.
//
// The host uses this to detect a stalled sidecar even when the process is
// technically alive (hung WebSocket read, deadlocked goroutine): a gap in
// `Counter` signals a missed tick, and comparing `TSMs` to the host's own
// clock catches gross clock skew. Both fields are monotonic within a single
// sidecar run; they reset on respawn.
type HeartbeatPayload struct {
	TSMs    int64  `json:"ts_ms"`
	Counter uint64 `json:"counter"`
}
