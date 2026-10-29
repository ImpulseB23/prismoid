package twitch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
	"unicode/utf8"
)

const defaultHelixBase = "https://api.twitch.tv/helix"

// ErrUnauthorized is a sentinel returned (wrapped inside [HelixError]) when
// the Helix API responds with 401. Callers use `errors.Is(err, ErrUnauthorized)`
// to decide whether to kick off a token refresh.
var ErrUnauthorized = errors.New("twitch helix: unauthorized")

// ErrRateLimited is returned after a 429 response when the automatic
// one-shot retry has already been consumed. Callers should back off per
// the per-provider token bucket (ADR 27 / PRI-20) before trying again.
var ErrRateLimited = errors.New("twitch helix: rate limit exceeded after retry")

// HelixError is the structured error body Helix returns on 4xx/5xx.
// Docs: https://dev.twitch.tv/docs/api/reference/ (error shape is documented
// per endpoint, but the envelope is always `{error, status, message}`).
type HelixError struct {
	Status  int    `json:"status"`
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *HelixError) Error() string {
	return fmt.Sprintf("twitch helix %d %s: %s", e.Status, e.Code, e.Message)
}

// Is lets `errors.Is(err, ErrUnauthorized)` / `errors.Is(err, ErrRateLimited)`
// succeed regardless of how the HelixError is wrapped up the call stack.
func (e *HelixError) Is(target error) bool {
	switch target {
	case ErrUnauthorized:
		return e.Status == http.StatusUnauthorized
	case ErrRateLimited:
		return e.Status == http.StatusTooManyRequests
	}
	return false
}

// HelixClient is a thin HTTP client for the Twitch Helix REST API. It owns
// the auth headers (Client-Id, Bearer token), base URL override for tests,
// and handles the Helix one-shot retry semantics on 429.
//
// Scope is deliberately narrow: no token bucket rate limiter (ADR 27 /
// PRI-20), no OAuth refresh on 401 (lives with the OAuth module). Callers
// receive `ErrUnauthorized` and decide whether to refresh + retry.
type HelixClient struct {
	HTTPClient  *http.Client
	BaseURL     string
	ClientID    string
	AccessToken string
}

// Do sends a request and decodes the JSON response into dst (nil for "don't
// care about the body"). On 429, it sleeps until `Ratelimit-Reset` and
// retries exactly once; a second 429 returns [ErrRateLimited].
//
// Context cancellation during the retry sleep returns `ctx.Err()`.
func (c *HelixClient) Do(ctx context.Context, method, path string, reqBody, dst any) error {
	for attempt := 0; attempt < 2; attempt++ {
		resp, err := c.doOnce(ctx, method, path, reqBody)
		if err != nil {
			return err
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			resetAt := parseRatelimitReset(resp.Header.Get("Ratelimit-Reset"))
			closeBody(resp)
			if attempt == 0 {
				if err := waitUntil(ctx, resetAt); err != nil {
					return err
				}
				continue
			}
			return &HelixError{Status: http.StatusTooManyRequests, Code: "Too Many Requests", Message: "rate limit exceeded"}
		}

		return decodeResponse(resp, dst)
	}
	// Unreachable: the loop either returns or continues, and we only `continue`
	// on the first attempt.
	return errors.New("twitch helix: impossible retry state")
}

// Get is a convenience wrapper for GET requests.
func (c *HelixClient) Get(ctx context.Context, path string, dst any) error {
	return c.Do(ctx, http.MethodGet, path, nil, dst)
}

// Post is a convenience wrapper for POST requests.
func (c *HelixClient) Post(ctx context.Context, path string, reqBody, dst any) error {
	return c.Do(ctx, http.MethodPost, path, reqBody, dst)
}

// Delete is a convenience wrapper for DELETE requests.
func (c *HelixClient) Delete(ctx context.Context, path string, dst any) error {
	return c.Do(ctx, http.MethodDelete, path, nil, dst)
}

func (c *HelixClient) doOnce(ctx context.Context, method, path string, reqBody any) (*http.Response, error) {
	base := c.BaseURL
	if base == "" {
		base = defaultHelixBase
	}

	var body io.Reader
	if reqBody != nil {
		buf, err := json.Marshal(reqBody)
		if err != nil {
			return nil, fmt.Errorf("marshal helix request body: %w", err)
		}
		body = bytes.NewReader(buf)
	}

	req, err := http.NewRequestWithContext(ctx, method, base+path, body)
	if err != nil {
		return nil, fmt.Errorf("build helix request: %w", err)
	}
	req.Header.Set("Client-Id", c.ClientID)
	req.Header.Set("Authorization", "Bearer "+c.AccessToken)
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("helix request: %w", err)
	}
	return resp, nil
}

// decodeResponse consumes resp.Body. Returns a structured HelixError for any
// non-2xx response; decodes JSON into dst for 2xx. A nil dst means the
// caller does not need the body (202 Accepted etc.).
func decodeResponse(resp *http.Response, dst any) error {
	defer closeBody(resp)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		buf, _ := io.ReadAll(resp.Body)
		he := &HelixError{Status: resp.StatusCode}
		// Best-effort decode. A non-JSON error body still surfaces via Message
		// with the raw bytes so callers can log it.
		if json.Unmarshal(buf, he) != nil {
			he.Message = string(buf)
		}
		return he
	}

	if dst == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}

	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		return fmt.Errorf("decode helix response: %w", err)
	}
	return nil
}

func closeBody(resp *http.Response) {
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
}

// parseRatelimitReset returns the absolute time the bucket refills. Twitch
// sends `Ratelimit-Reset` as a Unix-seconds timestamp. An empty or malformed
// value falls back to "retry immediately" (zero time).
func parseRatelimitReset(header string) time.Time {
	if header == "" {
		return time.Time{}
	}
	ts, err := strconv.ParseInt(header, 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.Unix(ts, 0)
}

// waitUntil blocks until either the deadline passes or ctx is cancelled.
// A zero-value deadline returns immediately.
func waitUntil(ctx context.Context, deadline time.Time) error {
	if deadline.IsZero() {
		return nil
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return nil
	}
	timer := time.NewTimer(remaining)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// chatSubscriptions lists every EventSub type the client needs for a chat
// view. All share the same condition and the user:read:chat scope.
var chatSubscriptions = []string{
	"channel.chat.message",
	"channel.chat.notification",
	"channel.chat.message_delete",
	"channel.chat.clear_user_messages",
	"channel.chat.clear",
	// Room modes, so the composer knows about slow mode even for viewers.
	"channel.chat_settings.update",
}

// Subscribe creates the EventSub subscriptions in chatSubscriptions that
// `have` lacks for one channel on a WebSocket session and returns their
// ids by type, so a later leave can delete exactly them. What it made
// before a failure part-way is returned alongside the error.
func Subscribe(ctx context.Context, client *HelixClient, sessionID, broadcasterID, userID string, have map[string]string) (map[string]string, error) {
	made := make(map[string]string, len(chatSubscriptions))
	for _, subType := range chatSubscriptions {
		if _, ok := have[subType]; ok {
			continue
		}
		req := SubscriptionRequest{
			Type:    subType,
			Version: "1",
			Condition: map[string]string{
				"broadcaster_user_id": broadcasterID,
				"user_id":             userID,
			},
			Transport: Transport{
				Method:    "websocket",
				SessionID: sessionID,
			},
		}
		var resp SubscriptionResponse
		if err := client.Post(ctx, "/eventsub/subscriptions", req, &resp); err != nil {
			return made, mapSubscribeError(err)
		}
		if len(resp.Data) == 0 {
			return made, errors.New("twitch helix: subscription response carried no data")
		}
		made[subType] = resp.Data[0].ID
	}
	return made, nil
}

// DeleteSubscription removes one EventSub subscription by id.
func DeleteSubscription(ctx context.Context, client *HelixClient, id string) error {
	q := url.Values{}
	q.Set("id", id)
	return client.Delete(ctx, "/eventsub/subscriptions?"+q.Encode(), nil)
}

// SubscribeModeration creates the channel.moderate v2 subscription, which
// reports every moderator action in the channel with who did it and why.
// Twitch only grants it to the broadcaster and their moderators and only
// with the full set of moderator:read scopes, so callers treat failure as
// "no moderation feed here" rather than a connection error.
func SubscribeModeration(ctx context.Context, client *HelixClient, sessionID, broadcasterID, moderatorID string) (string, error) {
	return subscribeAsModerator(ctx, client, "channel.moderate", sessionID, broadcasterID, moderatorID)
}

var automodTypes = []string{"automod.message.hold", "automod.message.update"}

// SubscribeAutoMod creates the automod.message.hold and .update v2
// subscriptions: messages AutoMod holds for review, and their outcome once
// a mod acts or they expire. Both need moderator:manage:automod, which
// older grants lack, so callers treat failure as "no queue here". Types in
// `have` are skipped; the ids made come back by type, alongside the error
// when one fails part-way.
func SubscribeAutoMod(ctx context.Context, client *HelixClient, sessionID, broadcasterID, moderatorID string, have map[string]string) (map[string]string, error) {
	made := make(map[string]string, len(automodTypes))
	for _, subType := range automodTypes {
		if _, ok := have[subType]; ok {
			continue
		}
		id, err := subscribeAsModerator(ctx, client, subType, sessionID, broadcasterID, moderatorID)
		if err != nil {
			return made, err
		}
		made[subType] = id
	}
	return made, nil
}

// broadcasterFeeds are the EventSub types Twitch only grants a broadcaster
// for their own channel, one group per scope: channel:manage:polls,
// channel:manage:predictions, then channel:read:ads.
var broadcasterFeeds = [][]string{
	{"channel.poll.begin", "channel.poll.progress", "channel.poll.end"},
	{"channel.prediction.begin", "channel.prediction.progress", "channel.prediction.lock", "channel.prediction.end"},
	{"channel.ad_break.begin"},
}

// SubscribeBroadcasterFeeds creates the poll, prediction and ad break v1
// subscriptions for the user's own channel. A group stops at its first
// refusal, since that means the grant lacks its scope, while the other
// group carries on. Types in `have` are skipped; the ids made come back by
// type alongside every group's error.
func SubscribeBroadcasterFeeds(ctx context.Context, client *HelixClient, sessionID, broadcasterID string, have map[string]string) (map[string]string, error) {
	made := make(map[string]string)
	var errs []error
	condition := map[string]string{"broadcaster_user_id": broadcasterID}
	for _, group := range broadcasterFeeds {
		for _, subType := range group {
			if _, ok := have[subType]; ok {
				continue
			}
			id, err := createSubscription(ctx, client, subType, "1", sessionID, condition)
			if err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", subType, err))
				break
			}
			made[subType] = id
		}
	}
	return made, errors.Join(errs...)
}

func subscribeAsModerator(ctx context.Context, client *HelixClient, subType, sessionID, broadcasterID, moderatorID string) (string, error) {
	return createSubscription(ctx, client, subType, "2", sessionID, map[string]string{
		"broadcaster_user_id": broadcasterID,
		"moderator_user_id":   moderatorID,
	})
}

func createSubscription(ctx context.Context, client *HelixClient, subType, version, sessionID string, condition map[string]string) (string, error) {
	req := SubscriptionRequest{
		Type:      subType,
		Version:   version,
		Condition: condition,
		Transport: Transport{
			Method:    "websocket",
			SessionID: sessionID,
		},
	}
	var resp SubscriptionResponse
	if err := client.Post(ctx, "/eventsub/subscriptions", req, &resp); err != nil {
		return "", err
	}
	if len(resp.Data) == 0 {
		return "", errors.New("twitch helix: subscription response carried no data")
	}
	return resp.Data[0].ID, nil
}

// mapSubscribeError preserves the existing callers' error surface: EventSub
// code uses errors.As against *AuthError to decide whether to surface an
// `auth_error` notification to the host. 401 maps onto that shape; 403 on
// a chat subscription means the user is banned or timed out in the channel
// (see the IRC migration guide), which gets its own type so the client can
// stop instead of reconnecting into the same answer.
func mapSubscribeError(err error) error {
	var he *HelixError
	if !errors.As(err, &he) {
		return err
	}
	switch he.Status {
	case http.StatusUnauthorized:
		return &AuthError{Status: he.Status, Body: he.Error()}
	case http.StatusForbidden:
		return &ChatAccessError{Status: he.Status, Body: he.Error()}
	}
	return err
}

// ErrChatBanned matches every error that means Twitch will not deliver a
// channel's chat to the signed-in user: the 403 at subscribe time and the
// `chat_user_banned` revocation mid-session.
var ErrChatBanned = errors.New("twitch chat: user banned or timed out")

// ChatAccessError is the 403 Helix answers when the user is banned or
// timed out in the channel they try to subscribe to.
type ChatAccessError struct {
	Status int
	Body   string
}

func (e *ChatAccessError) Error() string {
	return fmt.Sprintf("twitch chat access denied (%d): %s", e.Status, e.Body)
}

func (e *ChatAccessError) Is(target error) bool {
	return target == ErrChatBanned
}

// AuthError is the legacy 401 error type for EventSub callers that predate
// [HelixError]. Kept for backward compatibility with eventsub.go; new code
// should check `errors.Is(err, ErrUnauthorized)` against a HelixError
// directly instead.
type AuthError struct {
	Status int
	Body   string
}

func (e *AuthError) Error() string {
	return fmt.Sprintf("twitch auth error (%d): %s", e.Status, e.Body)
}

// Helix limit on a single chat message body. Messages longer than this are
// rejected with HTTP 400 by Twitch, so we mirror it locally to fail fast
// without consuming a Helix call.
const MaxChatMessageBytes = 500

// Helix enforces a 14-day maximum for timeout duration. Longer moderation
// actions should be sent as permanent bans.
const MaxTimeoutSeconds = 1209600

// SendChatMessageRequest is the body Twitch's POST /chat/messages expects.
// `BroadcasterID` is the channel; `SenderID` must match the authenticated
// user on the access token. `ReplyParentMessageID` is omitted for top-level
// sends.
type SendChatMessageRequest struct {
	BroadcasterID        string `json:"broadcaster_id"`
	SenderID             string `json:"sender_id"`
	Message              string `json:"message"`
	ReplyParentMessageID string `json:"reply_parent_message_id,omitempty"`
}

// SendChatMessageResponse is the envelope Twitch returns on 200. We surface
// the per-send drop reason (e.g. AutoMod, channel followers-only) so the UI
// can tell the user why a message did not appear.
type SendChatMessageResponse struct {
	Data []struct {
		MessageID  string `json:"message_id"`
		IsSent     bool   `json:"is_sent"`
		DropReason struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"drop_reason"`
	} `json:"data"`
}

// SendChatMessage posts a chat message via Helix and returns the parsed
// response. Caller is responsible for passing a non-empty message that fits
// in [MaxChatMessageBytes]; this method validates length up front to avoid
// a wasted round-trip.
func (c *HelixClient) SendChatMessage(ctx context.Context, broadcasterID, senderID, message, replyParentMessageID string) (*SendChatMessageResponse, error) {
	if message == "" {
		return nil, errors.New("twitch helix: empty chat message")
	}
	if len(message) > MaxChatMessageBytes {
		return nil, fmt.Errorf("twitch helix: chat message exceeds %d bytes", MaxChatMessageBytes)
	}
	req := SendChatMessageRequest{
		BroadcasterID:        broadcasterID,
		SenderID:             senderID,
		Message:              message,
		ReplyParentMessageID: replyParentMessageID,
	}
	var resp SendChatMessageResponse
	if err := c.Post(ctx, "/chat/messages", req, &resp); err != nil {
		return nil, err
	}
	return &resp, nil
}

type banUserRequest struct {
	Data banUserData `json:"data"`
}

type banUserData struct {
	UserID   string `json:"user_id"`
	Duration int    `json:"duration,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

func moderationBansPath(broadcasterID, moderatorID string) string {
	q := url.Values{}
	q.Set("broadcaster_id", broadcasterID)
	q.Set("moderator_id", moderatorID)
	return "/moderation/bans?" + q.Encode()
}

func (c *HelixClient) BanUser(ctx context.Context, broadcasterID, moderatorID, targetUserID, reason string) error {
	if broadcasterID == "" || moderatorID == "" || targetUserID == "" {
		return errors.New("twitch helix: missing broadcaster, moderator, or target user")
	}
	req := banUserRequest{Data: banUserData{UserID: targetUserID, Reason: reason}}
	return c.Post(ctx, moderationBansPath(broadcasterID, moderatorID), req, nil)
}

func (c *HelixClient) TimeoutUser(ctx context.Context, broadcasterID, moderatorID, targetUserID string, durationSeconds int, reason string) error {
	if broadcasterID == "" || moderatorID == "" || targetUserID == "" {
		return errors.New("twitch helix: missing broadcaster, moderator, or target user")
	}
	if durationSeconds < 1 || durationSeconds > MaxTimeoutSeconds {
		return fmt.Errorf("twitch helix: timeout duration out of range [1, %d]", MaxTimeoutSeconds)
	}
	req := banUserRequest{Data: banUserData{UserID: targetUserID, Duration: durationSeconds, Reason: reason}}
	return c.Post(ctx, moderationBansPath(broadcasterID, moderatorID), req, nil)
}

// MaxWarningReasonChars is Twitch's cap on a warning's reason.
const MaxWarningReasonChars = 500

type warnUserRequest struct {
	Data warnUserData `json:"data"`
}

type warnUserData struct {
	UserID string `json:"user_id"`
	Reason string `json:"reason"`
}

// WarnUser makes the target acknowledge reason before they can chat again.
// Twitch requires the reason.
func (c *HelixClient) WarnUser(ctx context.Context, broadcasterID, moderatorID, targetUserID, reason string) error {
	if broadcasterID == "" || moderatorID == "" || targetUserID == "" {
		return errors.New("twitch helix: missing broadcaster, moderator, or target user")
	}
	if reason == "" || utf8.RuneCountInString(reason) > MaxWarningReasonChars {
		return fmt.Errorf("twitch helix: warning reason must be 1 to %d characters", MaxWarningReasonChars)
	}
	q := url.Values{}
	q.Set("broadcaster_id", broadcasterID)
	q.Set("moderator_id", moderatorID)
	req := warnUserRequest{Data: warnUserData{UserID: targetUserID, Reason: reason}}
	return c.Post(ctx, "/moderation/warnings?"+q.Encode(), req, nil)
}

func (c *HelixClient) UnbanUser(ctx context.Context, broadcasterID, moderatorID, targetUserID string) error {
	if broadcasterID == "" || moderatorID == "" || targetUserID == "" {
		return errors.New("twitch helix: missing broadcaster, moderator, or target user")
	}
	q := url.Values{}
	q.Set("broadcaster_id", broadcasterID)
	q.Set("moderator_id", moderatorID)
	q.Set("user_id", targetUserID)
	return c.Delete(ctx, "/moderation/bans?"+q.Encode(), nil)
}

func (c *HelixClient) DeleteChatMessage(ctx context.Context, broadcasterID, moderatorID, messageID string) error {
	if broadcasterID == "" || moderatorID == "" || messageID == "" {
		return errors.New("twitch helix: missing broadcaster, moderator, or message id")
	}
	q := url.Values{}
	q.Set("broadcaster_id", broadcasterID)
	q.Set("moderator_id", moderatorID)
	q.Set("message_id", messageID)
	return c.Delete(ctx, "/moderation/chat?"+q.Encode(), nil)
}

// ClearChat removes every message in the channel: the same endpoint as
// DeleteChatMessage with no message id.
func (c *HelixClient) ClearChat(ctx context.Context, broadcasterID, moderatorID string) error {
	if broadcasterID == "" || moderatorID == "" {
		return errors.New("twitch helix: missing broadcaster or moderator id")
	}
	q := url.Values{}
	q.Set("broadcaster_id", broadcasterID)
	q.Set("moderator_id", moderatorID)
	return c.Delete(ctx, "/moderation/chat?"+q.Encode(), nil)
}

type manageHeldMessageRequest struct {
	UserID string `json:"user_id"`
	MsgID  string `json:"msg_id"`
	Action string `json:"action"`
}

// ManageHeldMessage allows or denies a message AutoMod is holding for
// review. action is ALLOW or DENY.
func (c *HelixClient) ManageHeldMessage(ctx context.Context, moderatorID, messageID, action string) error {
	if moderatorID == "" || messageID == "" {
		return errors.New("twitch helix: missing moderator or message id")
	}
	if action != "ALLOW" && action != "DENY" {
		return fmt.Errorf("twitch helix: automod action %q is not ALLOW or DENY", action)
	}
	req := manageHeldMessageRequest{UserID: moderatorID, MsgID: messageID, Action: action}
	return c.Post(ctx, "/moderation/automod/message", req, nil)
}
