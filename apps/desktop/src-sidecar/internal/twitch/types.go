package twitch

import "encoding/json"

// Envelope is the top-level EventSub WebSocket message.
type Envelope struct {
	Metadata Metadata        `json:"metadata"`
	Payload  json.RawMessage `json:"payload"`
}

type Metadata struct {
	MessageID   string `json:"message_id"`
	MessageType string `json:"message_type"`
	Timestamp   string `json:"message_timestamp"`
}

type WelcomePayload struct {
	Session WelcomeSession `json:"session"`
}

type WelcomeSession struct {
	ID                      string `json:"id"`
	KeepaliveTimeoutSeconds int    `json:"keepalive_timeout_seconds"`
}

// RevocationPayload is the body of a `revocation` envelope. Twitch puts the
// reason in the subscription's status; `chat_user_banned` is the one that
// means the user was banned or timed out in the channel.
type RevocationPayload struct {
	Subscription struct {
		Type      string `json:"type"`
		Status    string `json:"status"`
		Condition struct {
			BroadcasterUserID string `json:"broadcaster_user_id"`
		} `json:"condition"`
	} `json:"subscription"`
}

const revokedChatUserBanned = "chat_user_banned"

type ReconnectPayload struct {
	Session ReconnectSession `json:"session"`
}

type ReconnectSession struct {
	ID           string `json:"id"`
	ReconnectURL string `json:"reconnect_url"`
}

type SubscriptionRequest struct {
	Type      string            `json:"type"`
	Version   string            `json:"version"`
	Condition map[string]string `json:"condition"`
	Transport Transport         `json:"transport"`
}

type Transport struct {
	Method    string `json:"method"`
	SessionID string `json:"session_id"`
}

type SubscriptionResponse struct {
	Data []SubscriptionData `json:"data"`
}

type SubscriptionData struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}
