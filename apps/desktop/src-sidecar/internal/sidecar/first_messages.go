package sidecar

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/twitch"
)

// FirstMessagePayload is the body of a `first_message` notification: the
// message with this id is its chatter's first in the channel.
type FirstMessagePayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
}

// UserClearPayload is the body of a `user_clear` notification: how a user
// whose messages were cleared was removed. DurationSeconds is nil for a ban.
type UserClearPayload struct {
	ChannelID       string `json:"channel_id"`
	TargetUserID    string `json:"target_user_id"`
	DurationSeconds *int   `json:"duration_seconds"`
}

// firstMessages owns the shared IRC watcher. It always runs, since every
// viewer wants to know whether a cleared user was timed out or banned;
// first messages are only reported while the host has that feature on.
// Logins are kept by broadcaster id because a disconnect command carries
// only the id. Used from the command loop goroutine only.
type firstMessages struct {
	watcher *twitch.FirstMessageWatcher
	logins  map[string]string
	firsts  *atomic.Bool
	logger  zerolog.Logger
}

func newFirstMessages(notify twitch.Notify, logger zerolog.Logger) *firstMessages {
	logger = logger.With().Str("component", "first_messages").Logger()
	// The watcher calls back on its own goroutine.
	firsts := new(atomic.Bool)
	onFirst := func(channelID, messageID string) {
		if firsts.Load() {
			notify("first_message", FirstMessagePayload{ChannelID: channelID, MessageID: messageID})
		}
	}
	onClear := func(channelID, userID string, seconds int) {
		p := UserClearPayload{ChannelID: channelID, TargetUserID: userID}
		if seconds > 0 {
			p.DurationSeconds = &seconds
		}
		notify("user_clear", p)
	}
	return &firstMessages{
		watcher: twitch.NewFirstMessageWatcher(onFirst, onClear, logger),
		logins:  make(map[string]string),
		firsts:  firsts,
		logger:  logger,
	}
}

func (f *firstMessages) run(ctx context.Context) {
	if err := f.watcher.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		f.logger.Error().Err(err).Msg("irc watcher exited")
	}
}

func (f *firstMessages) join(broadcasterID, login string) {
	if login == "" {
		return
	}
	f.logins[broadcasterID] = login
	f.watcher.Join(login)
}

func (f *firstMessages) part(broadcasterID string) {
	login, ok := f.logins[broadcasterID]
	if !ok {
		return
	}
	delete(f.logins, broadcasterID)
	f.watcher.Part(login)
}

func (f *firstMessages) setEnabled(on bool) {
	f.firsts.Store(on)
}
