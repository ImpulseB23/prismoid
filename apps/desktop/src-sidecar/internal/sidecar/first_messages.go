package sidecar

import (
	"context"
	"errors"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/twitch"
)

// FirstMessagePayload is the body of a `first_message` notification: the
// message with this id is its chatter's first in the channel.
type FirstMessagePayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
}

// firstMessages owns the shared first-message watcher. The watcher only
// connects while the host has the feature switched on, but every joined
// channel is tracked either way, so switching it on joins whatever is
// already open. Logins are kept by broadcaster id because a disconnect
// command carries only the id. Used from the command loop goroutine only.
type firstMessages struct {
	ctx     context.Context
	watcher *twitch.FirstMessageWatcher
	logins  map[string]string
	stop    context.CancelFunc
	done    chan struct{}
	logger  zerolog.Logger
}

func newFirstMessages(ctx context.Context, notify twitch.Notify, logger zerolog.Logger) *firstMessages {
	logger = logger.With().Str("component", "first_messages").Logger()
	onFirst := func(channelID, messageID string) {
		notify("first_message", FirstMessagePayload{ChannelID: channelID, MessageID: messageID})
	}
	return &firstMessages{
		ctx:     ctx,
		watcher: twitch.NewFirstMessageWatcher(onFirst, logger),
		logins:  make(map[string]string),
		logger:  logger,
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

// setEnabled starts or stops the watcher. Stopping waits for it to exit so
// a quick off and on never runs two connections at once.
func (f *firstMessages) setEnabled(on bool) {
	if on == (f.stop != nil) {
		return
	}
	if !on {
		f.stop()
		<-f.done
		f.stop, f.done = nil, nil
		f.logger.Info().Msg("first message watcher stopped")
		return
	}
	ctx, cancel := context.WithCancel(f.ctx)
	done := make(chan struct{})
	f.stop, f.done = cancel, done
	go func() {
		defer close(done)
		if err := f.watcher.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			f.logger.Error().Err(err).Msg("first message watcher exited")
		}
	}()
	f.logger.Info().Msg("first message watcher started")
}
