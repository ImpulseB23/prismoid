package sidecar

import (
	"context"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
	"github.com/ImpulseB23/Prismoid/sidecar/internal/twitch"
)

// emoteBundles fetches each joined Twitch channel's emote and badge bundle,
// and fetches it again when the 7TV switch flips so 7TV emotes come and go
// without a rejoin. A new fetch cancels the one still running for that
// channel, so an older bundle never lands last. Only the command loop
// goroutine calls it.
type emoteBundles struct {
	notify   twitch.Notify
	log      zerolog.Logger
	sevenTV  bool
	channels map[string]*bundleChannel
}

type bundleChannel struct {
	ctx    context.Context
	cmd    control.Command
	cancel context.CancelFunc
}

func newEmoteBundles(notify twitch.Notify, log zerolog.Logger) *emoteBundles {
	return &emoteBundles{
		notify:   notify,
		log:      log,
		sevenTV:  true,
		channels: make(map[string]*bundleChannel),
	}
}

// join fetches a channel's bundle now; ctx ends with the channel.
func (e *emoteBundles) join(ctx context.Context, cmd control.Command) {
	ch := &bundleChannel{ctx: ctx, cmd: cmd}
	e.channels[cmd.BroadcasterID] = ch
	e.fetch(ch)
}

func (e *emoteBundles) part(broadcasterID string) {
	delete(e.channels, broadcasterID)
}

// setToken keeps later fetches signed in after a token refresh.
func (e *emoteBundles) setToken(token string) {
	for _, ch := range e.channels {
		ch.cmd.Token = token
	}
}

func (e *emoteBundles) setSevenTV(on bool) {
	if e.sevenTV == on {
		return
	}
	e.sevenTV = on
	for _, ch := range e.channels {
		e.fetch(ch)
	}
}

func (e *emoteBundles) fetch(ch *bundleChannel) {
	if ch.cancel != nil {
		ch.cancel()
	}
	ctx, cancel := context.WithCancel(ch.ctx)
	ch.cancel = cancel
	go emoteFetchFn(ctx, ch.cmd, e.sevenTV, e.notify, e.log)
}
