package control

type Command struct {
	Cmd           string `json:"cmd"`
	Channel       string `json:"channel,omitempty"`
	Token         string `json:"token,omitempty"`
	ClientID      string `json:"client_id,omitempty"`
	BroadcasterID string `json:"broadcaster_id,omitempty"`
	UserID        string `json:"user_id,omitempty"`
	ShmName       string `json:"shm_name,omitempty"`
	ShmSize       int    `json:"shm_size,omitempty"`
}

type Message struct {
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
}
