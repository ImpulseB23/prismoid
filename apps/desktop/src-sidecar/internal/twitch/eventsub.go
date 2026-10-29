package twitch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/backoff"
	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
)

const defaultWSURL = "wss://eventsub.wss.twitch.tv/ws"

// Notify is called on control-plane events (auth errors, revocations) that
// the Rust host should know about. The caller wires this to stdout JSON.
type Notify func(msgType string, payload any)

// ChatBannedPayload is the `chat_banned` notification: Twitch refuses to
// deliver this channel's chat to the signed-in user, who is banned or timed
// out there. Detail carries Twitch's own wording (403 body or revocation
// status) for the log and the UI.
type ChatBannedPayload struct {
	BroadcasterID string `json:"broadcaster_id"`
	Detail        string `json:"detail"`
}

// Session owns one EventSub WebSocket and the chat subscriptions of every
// joined channel. Twitch allows three sockets per user, so channels share
// one: a join adds that channel's subscriptions to the live session, a
// leave deletes them, and a fresh socket subscribes every joined channel
// again. Notifications for all channels flow to Out as raw envelope bytes;
// the host routes them by broadcaster id.
type Session struct {
	HelixBase string // override for testing; "" uses default
	WSURL     string // override for testing; "" uses default

	Out    chan<- []byte
	Log    zerolog.Logger
	Notify Notify

	ctx context.Context

	mu          sync.Mutex
	userID      string
	clientID    string
	accessToken string
	channels    map[string]*channelSubs
	// sessionID is "" while no socket is up; subscriptions made against it
	// die with the socket.
	sessionID string
	running   bool
	// off holds the feeds the user switched off with their feature.
	off map[Feed]bool
}

// Feed is a group of subscriptions serving one feature the user can switch
// off. Chat itself always runs.
type Feed string

const (
	// FeedModeration is channel.moderate and the AutoMod queue.
	FeedModeration Feed = "moderation"
	// FeedBroadcaster is polls, predictions and ad breaks on the user's
	// own channel, for the stream manager.
	FeedBroadcaster Feed = "broadcaster"
)

// feedOf names the feed a subscription type belongs to, "" for chat.
func feedOf(subType string) Feed {
	if subType == "channel.moderate" || slices.Contains(automodTypes, subType) {
		return FeedModeration
	}
	for _, group := range broadcasterFeeds {
		if slices.Contains(group, subType) {
			return FeedBroadcaster
		}
	}
	return ""
}

// channelSubs is one joined channel: its live subscription ids by type and
// what to do when Twitch says the user may not read it. One goroutine at a
// time subscribes a channel; a request while it runs sets rerun so the
// runner goes again instead of racing it into duplicate subscriptions.
type channelSubs struct {
	ids      map[string]string
	onBanned func(detail string)
	running  bool
	rerun    bool
}

func (c *channelSubs) idList() []string {
	ids := make([]string, 0, len(c.ids))
	for _, id := range c.ids {
		ids = append(ids, id)
	}
	return ids
}

// NewSession makes an idle session; the socket opens on the first Join and
// closes once ctx ends.
func NewSession(ctx context.Context, out chan<- []byte, log zerolog.Logger, notify Notify) *Session {
	return &Session{
		Out:      out,
		Log:      log,
		Notify:   notify,
		ctx:      ctx,
		channels: make(map[string]*channelSubs),
		off:      make(map[Feed]bool),
	}
}

// SetFeed switches a feed on or off for every joined channel. Off deletes
// its subscriptions and stops new ones; on adds them back on the live
// socket.
func (s *Session) SetFeed(feed Feed, on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.off[feed] == !on {
		return
	}
	s.off[feed] = !on
	if on {
		if s.sessionID != "" {
			for id := range s.channels {
				s.startSubscribe(id)
			}
		}
		return
	}
	var ids []string
	for _, subs := range s.channels {
		for subType, id := range subs.ids {
			if feedOf(subType) == feed {
				ids = append(ids, id)
				delete(subs.ids, subType)
			}
		}
	}
	if len(ids) > 0 {
		go s.deleteSubscriptions(ids)
	}
}

// Configure sets the identity every subscription is made as. The token can
// be rotated later with SetAccessToken.
func (s *Session) Configure(userID, accessToken, clientID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.userID = userID
	s.clientID = clientID
	s.accessToken = accessToken
}

// AccessToken returns the current token. Safe for concurrent use.
func (s *Session) AccessToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.accessToken
}

// SetAccessToken rotates the token. The next subscribe or Helix call picks
// up the new value.
func (s *Session) SetAccessToken(token string) {
	s.mu.Lock()
	s.accessToken = token
	s.mu.Unlock()
}

// Joined lists the broadcaster ids currently followed.
func (s *Session) Joined() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := make([]string, 0, len(s.channels))
	for id := range s.channels {
		ids = append(ids, id)
	}
	return ids
}

// Join starts delivering a channel's chat. If the socket is already up the
// subscriptions go out now; otherwise they go out when it connects.
// `onBanned` runs (at most once per join) when Twitch refuses the chat for
// a ban or timeout, after which the channel is dropped from the session.
func (s *Session) Join(broadcasterID string, onBanned func(detail string)) {
	s.mu.Lock()
	if _, exists := s.channels[broadcasterID]; exists {
		s.mu.Unlock()
		return
	}
	s.channels[broadcasterID] = &channelSubs{ids: map[string]string{}, onBanned: onBanned}
	if !s.running {
		s.running = true
		go s.run()
	}
	if s.sessionID != "" {
		s.startSubscribe(broadcasterID)
	}
	s.mu.Unlock()
}

// Resubscribe adds whatever subscriptions each joined channel is missing on
// the live socket, as the current token. Called after a sign-in grants new
// scopes; what already works is left alone, so chat never drops.
func (s *Session) Resubscribe() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessionID == "" {
		return
	}
	for id := range s.channels {
		s.startSubscribe(id)
	}
}

// startSubscribe runs subscribeChannel for a joined channel, or has the
// one already running go again. Callers hold s.mu and a live session.
func (s *Session) startSubscribe(broadcasterID string) {
	subs := s.channels[broadcasterID]
	if subs.running {
		subs.rerun = true
		return
	}
	subs.running = true
	go s.subscribeChannel(s.sessionID, broadcasterID)
}

// Leave stops delivering a channel's chat and deletes its subscriptions.
func (s *Session) Leave(broadcasterID string) {
	s.mu.Lock()
	subs, ok := s.channels[broadcasterID]
	delete(s.channels, broadcasterID)
	s.mu.Unlock()
	if !ok || len(subs.ids) == 0 {
		return
	}
	go s.deleteSubscriptions(subs.idList())
}

func (s *Session) helix() *HelixClient {
	s.mu.Lock()
	defer s.mu.Unlock()
	return &HelixClient{
		BaseURL:     s.HelixBase,
		ClientID:    s.clientID,
		AccessToken: s.accessToken,
	}
}

// subscribeChannel creates the subscriptions one channel lacks, going again
// for as long as reruns were requested while it worked.
func (s *Session) subscribeChannel(sessionID, broadcasterID string) {
	for {
		next, again := s.subscribeMissing(sessionID, broadcasterID)
		if !again {
			return
		}
		sessionID = next
	}
}

// subscribeMissing creates the subscriptions the channel has none of on
// `sessionID` and records their ids, unless the channel left or the socket
// changed in the meantime. A 403 on chat means the user is banned or timed
// out there. It returns the session to go again on when a rerun is due.
func (s *Session) subscribeMissing(sessionID, broadcasterID string) (string, bool) {
	s.mu.Lock()
	userID := s.userID
	have := map[string]string{}
	if subs, ok := s.channels[broadcasterID]; ok {
		maps.Copy(have, subs.ids)
	}
	off := maps.Clone(s.off)
	s.mu.Unlock()

	made, err := Subscribe(s.ctx, s.helix(), sessionID, broadcasterID, userID, have)
	if err == nil && !off[FeedModeration] {
		if _, ok := have["channel.moderate"]; !ok {
			// Twitch only grants channel.moderate to the broadcaster and
			// their moderators, so a refusal here is the normal case in
			// most channels.
			if modID, modErr := SubscribeModeration(s.ctx, s.helix(), sessionID, broadcasterID, userID); modErr != nil {
				s.Log.Info().Err(modErr).Str("broadcaster", broadcasterID).Msg("moderation feed unavailable; not a moderator here or scopes missing")
			} else {
				made["channel.moderate"] = modID
			}
		}
		// AutoMod is only tried where channel.moderate is in place, so the
		// user is known to moderate here. A refusal then means the grant
		// predates moderator:manage:automod; the app asks for a reconnect
		// and the resubscribe after it fills these in.
		_, modded := made["channel.moderate"]
		if _, ok := have["channel.moderate"]; ok || modded {
			automod, amErr := SubscribeAutoMod(s.ctx, s.helix(), sessionID, broadcasterID, userID, have)
			maps.Copy(made, automod)
			if amErr != nil {
				s.Log.Info().Err(amErr).Str("broadcaster", broadcasterID).Msg("automod queue unavailable; moderator:manage:automod likely missing")
			}
		}
	}
	if err == nil && !off[FeedBroadcaster] {
		// Polls, predictions and ad breaks only exist for the user's own
		// channel. A refusal there means the grant predates the stream
		// manager scopes; the resubscribe after a reconnect fills them in.
		if broadcasterID == userID {
			feeds, feedErr := SubscribeBroadcasterFeeds(s.ctx, s.helix(), sessionID, broadcasterID, have)
			maps.Copy(made, feeds)
			if feedErr != nil {
				s.Log.Info().Err(feedErr).Str("broadcaster", broadcasterID).Msg("poll, prediction or ad break feed unavailable; stream manager scopes likely missing")
			}
		}
	}

	s.mu.Lock()
	subs, ok := s.channels[broadcasterID]
	stale := s.sessionID != sessionID
	// A feed switched off while these were being made is deleted again.
	var switchedOff []string
	if ok && !stale {
		for subType, id := range made {
			if s.off[feedOf(subType)] {
				switchedOff = append(switchedOff, id)
			} else {
				subs.ids[subType] = id
			}
		}
	}
	next, again := "", false
	if ok {
		if subs.rerun && s.sessionID != "" {
			subs.rerun = false
			next, again = s.sessionID, true
		} else {
			subs.running = false
			subs.rerun = false
		}
	}
	s.mu.Unlock()
	if len(switchedOff) > 0 {
		go s.deleteSubscriptions(switchedOff)
	}
	if !ok || stale {
		ids := make([]string, 0, len(made))
		for _, id := range made {
			ids = append(ids, id)
		}
		go s.deleteSubscriptions(ids)
	}

	if err != nil {
		var denied *ChatAccessError
		if errors.As(err, &denied) {
			s.Log.Warn().Str("broadcaster", broadcasterID).Str("body", denied.Body).Msg("chat subscription forbidden: banned or timed out")
			s.dropBanned(broadcasterID, denied.Body)
			return "", false
		}
		var authErr *AuthError
		if errors.As(err, &authErr) && s.Notify != nil {
			s.Notify("auth_error", authErr.Error())
		}
		s.Log.Error().Err(err).Str("broadcaster", broadcasterID).Msg("chat subscribe failed")
		return next, again
	}
	if ok && !stale && len(made) > 0 {
		s.Log.Info().Str("broadcaster", broadcasterID).Int("subscriptions", len(made)).Msg("subscribed to chat events")
	}
	return next, again
}

// dropBanned removes a channel Twitch will not deliver and tells its owner.
func (s *Session) dropBanned(broadcasterID, detail string) {
	s.mu.Lock()
	subs, ok := s.channels[broadcasterID]
	delete(s.channels, broadcasterID)
	s.mu.Unlock()
	if !ok {
		return
	}
	if s.Notify != nil {
		s.Notify("chat_banned", ChatBannedPayload{BroadcasterID: broadcasterID, Detail: detail})
	}
	if subs.onBanned != nil {
		subs.onBanned(detail)
	}
	if len(subs.ids) > 0 {
		go s.deleteSubscriptions(subs.idList())
	}
}

func (s *Session) deleteSubscriptions(ids []string) {
	client := s.helix()
	for _, id := range ids {
		if err := DeleteSubscription(s.ctx, client, id); err != nil && s.ctx.Err() == nil {
			s.Log.Warn().Err(err).Str("subscription", id).Msg("failed to delete eventsub subscription")
		}
	}
}

// run keeps a socket up while there are channels to follow, reconnecting
// with backoff. It returns when the context ends or the last channel left,
// in which case the next Join starts it again.
func (s *Session) run() {
	bo := backoff.New(1*time.Second, 30*time.Second)
	wsURL := s.wsURL()

	for {
		s.mu.Lock()
		if len(s.channels) == 0 || s.ctx.Err() != nil {
			s.running = false
			s.sessionID = ""
			s.mu.Unlock()
			return
		}
		s.mu.Unlock()

		err := s.connectAndListen(s.ctx, wsURL)

		s.mu.Lock()
		s.sessionID = ""
		s.mu.Unlock()

		if s.ctx.Err() != nil {
			continue
		}
		var re *reconnectError
		if errors.As(err, &re) {
			wsURL = re.url
			bo.Reset()
			continue
		}
		wsURL = s.wsURL()
		s.Log.Warn().Err(err).Msg("eventsub disconnected, reconnecting")
		select {
		case <-s.ctx.Done():
		case <-time.After(bo.Next()):
		}
	}
}

func (s *Session) wsURL() string {
	if s.WSURL != "" {
		return s.WSURL
	}
	return defaultWSURL
}

func (s *Session) connectAndListen(ctx context.Context, url string) error {
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return fmt.Errorf("dial %s: %w", url, err)
	}
	defer func() { _ = conn.CloseNow() }()

	sessionID, keepalive, err := readWelcome(ctx, conn)
	if err != nil {
		return err
	}
	s.Log.Info().Str("session", sessionID).Int("keepalive_s", keepalive).Msg("connected to eventsub")

	// A reconnect URL carries the old session's subscriptions over, so only
	// a fresh socket subscribes the joined channels again.
	s.mu.Lock()
	carried := url != s.wsURL()
	s.sessionID = sessionID
	if !carried {
		for id, subs := range s.channels {
			clear(subs.ids)
			s.startSubscribe(id)
		}
	}
	s.mu.Unlock()

	return s.listenLoop(ctx, conn, keepalive)
}

func readWelcome(ctx context.Context, conn *websocket.Conn) (string, int, error) {
	// twitch expects subscription within keepalive_timeout_seconds (default 10s)
	readCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	_, data, err := conn.Read(readCtx)
	if err != nil {
		return "", 0, fmt.Errorf("read welcome: %w", err)
	}

	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return "", 0, fmt.Errorf("unmarshal welcome: %w", err)
	}

	if env.Metadata.MessageType != "session_welcome" {
		return "", 0, fmt.Errorf("expected session_welcome, got %s", env.Metadata.MessageType)
	}

	var payload WelcomePayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		return "", 0, fmt.Errorf("unmarshal welcome payload: %w", err)
	}

	return payload.Session.ID, payload.Session.KeepaliveTimeoutSeconds, nil
}

func (s *Session) listenLoop(ctx context.Context, conn *websocket.Conn, keepaliveSec int) error {
	// Each Read uses a fresh context.WithTimeout, so the keepalive timeout is
	// enforced per read. No standalone timer needed.
	timeout := time.Duration(keepaliveSec)*time.Second + time.Second

	for {
		readCtx, cancel := context.WithTimeout(ctx, timeout)
		_, data, err := conn.Read(readCtx)
		cancel()
		if err != nil {
			if errors.Is(err, context.Canceled) && ctx.Err() != nil {
				_ = conn.Close(websocket.StatusNormalClosure, "shutting down")
				return ctx.Err()
			}
			return fmt.Errorf("read: %w", err)
		}

		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			s.Log.Error().Err(err).Msg("unmarshal envelope failed")
			continue
		}

		switch env.Metadata.MessageType {
		case "notification":
			// Non-blocking send. The receiver (the writer goroutine in the
			// sidecar) is the sole producer to the ring buffer; if its input
			// channel is full it means the ring buffer is also full or close
			// to it. We drop the *new* message (drop-newest) rather than
			// stall the websocket reader. Note: docs/architecture.md
			// describes drop-oldest at the ring buffer layer; the current
			// SPSC primitive cannot evict already-written messages without a
			// reader-side cooperation we haven't built yet. Tracked
			// separately.
			tagged := make([]byte, 1+len(data))
			tagged[0] = control.TagTwitch
			copy(tagged[1:], data)

			select {
			case s.Out <- tagged:
			default:
				s.Log.Warn().Msg("output channel full, dropping message")
			}

		case "session_keepalive":
			// no-op; per-read timeout above resets on every successful Read

		case "session_reconnect":
			var payload ReconnectPayload
			if err := json.Unmarshal(env.Payload, &payload); err != nil {
				s.Log.Error().Err(err).Msg("unmarshal reconnect payload")
				continue
			}
			s.Log.Info().Str("url", payload.Session.ReconnectURL).Msg("reconnect requested")
			return &reconnectError{url: payload.Session.ReconnectURL}

		case "revocation":
			var payload RevocationPayload
			if err := json.Unmarshal(env.Payload, &payload); err != nil {
				s.Log.Error().Err(err).Msg("unmarshal revocation payload")
			}
			sub := payload.Subscription
			s.Log.Warn().Str("status", sub.Status).Str("broadcaster", sub.Condition.BroadcasterUserID).RawJSON("payload", env.Payload).Msg("subscription revoked")
			// Only this channel is affected; the socket and every other
			// channel carry on.
			if sub.Status == revokedChatUserBanned {
				s.dropBanned(sub.Condition.BroadcasterUserID, sub.Status)
				continue
			}
			if s.Notify != nil {
				s.Notify("revocation", json.RawMessage(env.Payload))
			}

		default:
			s.Log.Debug().Str("type", env.Metadata.MessageType).Msg("unhandled message type")
		}
	}
}

type reconnectError struct {
	url string
}

func (e *reconnectError) Error() string {
	return "reconnect to " + e.url
}
