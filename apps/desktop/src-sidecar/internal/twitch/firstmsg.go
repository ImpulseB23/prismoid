package twitch

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/backoff"
)

// Twitch allows an anonymous connection 20 JOINs per 10 seconds.
const (
	joinBurst  = 20
	joinWindow = 10 * time.Second
)

// FirstMessageWatcher reads what EventSub leaves out for a viewer: a
// chatter's first message in a channel, which IRC tags `first-msg=1` (the
// IRC `id` is the EventSub message_id, so the host can match the two), and
// whether a cleared user was timed out, and for how long, or banned. One
// anonymous read-only connection serves every channel; Join and Part may be
// called from any goroutine, running or not, and a running watcher follows
// them.
type FirstMessageWatcher struct {
	// Addr overrides the Twitch IRC endpoint; "" uses the default.
	Addr string
	// Dial overrides the TLS dial; tests point it at a plain listener.
	Dial func(ctx context.Context, addr string) (net.Conn, error)
	// OnFirst gets the channel's room-id and the message id.
	OnFirst func(channelID, messageID string)
	// OnClear gets the channel's room-id, the user's id and the timeout
	// length in seconds, 0 for a ban.
	OnClear func(channelID, userID string, seconds int)
	Log     zerolog.Logger

	mu       sync.Mutex
	channels map[string]struct{}
	wake     chan struct{}
	limiter  joinLimiter
}

func NewFirstMessageWatcher(onFirst func(channelID, messageID string), onClear func(channelID, userID string, seconds int), log zerolog.Logger) *FirstMessageWatcher {
	return &FirstMessageWatcher{
		OnFirst:  onFirst,
		OnClear:  onClear,
		Log:      log,
		channels: make(map[string]struct{}),
		wake:     make(chan struct{}, 1),
		limiter:  joinLimiter{burst: joinBurst, window: joinWindow},
	}
}

func (w *FirstMessageWatcher) Join(login string) {
	w.mu.Lock()
	w.channels[login] = struct{}{}
	w.mu.Unlock()
	w.poke()
}

func (w *FirstMessageWatcher) Part(login string) {
	w.mu.Lock()
	delete(w.channels, login)
	w.mu.Unlock()
	w.poke()
}

func (w *FirstMessageWatcher) poke() {
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// Run watches until ctx is cancelled, reconnecting with backoff and
// rejoining every channel on each new connection. Only one Run may be
// active at a time.
func (w *FirstMessageWatcher) Run(ctx context.Context) error {
	bo := backoff.New(time.Second, 30*time.Second)
	for {
		err := w.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, errIRCReconnect) {
			bo.Reset()
			continue
		}
		w.Log.Warn().Err(err).Msg("first message watcher disconnected, reconnecting")
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(bo.Next()):
		}
	}
}

func (w *FirstMessageWatcher) session(ctx context.Context) error {
	conn, err := dialIRC(ctx, w.Addr, w.Dial)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer func() { _ = conn.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	// PONGs from the read loop and JOIN/PART from the sync goroutine share
	// the socket.
	var writeMu sync.Mutex
	write := func(s string) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_, err := io.WriteString(conn, s)
		return err
	}

	nick := fmt.Sprintf("justinfan%d", 10000+rand.IntN(90000))
	if err := write(fmt.Sprintf("CAP REQ :twitch.tv/tags twitch.tv/commands\r\nNICK %s\r\n", nick)); err != nil {
		return fmt.Errorf("handshake: %w", err)
	}

	syncCtx, cancelSync := context.WithCancel(ctx)
	synced := make(chan struct{})
	go func() {
		defer close(synced)
		if err := w.syncChannels(syncCtx, write); err != nil {
			w.Log.Warn().Err(err).Msg("first message watcher write failed")
			// Unblocks the read below so the session restarts.
			_ = conn.Close()
		}
	}()
	defer func() {
		cancelSync()
		<-synced
	}()

	rd := bufio.NewReaderSize(conn, 64*1024)
	for {
		if err := conn.SetReadDeadline(time.Now().Add(ircReadTimeout)); err != nil {
			return fmt.Errorf("deadline: %w", err)
		}
		line, err := rd.ReadString('\n')
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		switch ircCommand(line) {
		case "PING":
			if err := write("PONG :tmi.twitch.tv\r\n"); err != nil {
				return fmt.Errorf("pong: %w", err)
			}
		case "RECONNECT":
			return errIRCReconnect
		case "PRIVMSG":
			w.handlePrivmsg(line)
		case "CLEARCHAT":
			w.handleClearchat(line)
		}
	}
}

func (w *FirstMessageWatcher) handlePrivmsg(line string) {
	tags := parseIRCTags(line)
	if tags["first-msg"] != "1" {
		return
	}
	room, id := tags["room-id"], tags["id"]
	if room == "" || id == "" {
		return
	}
	w.OnFirst(room, id)
}

// handleClearchat reports a user's timeout or ban. A CLEARCHAT without a
// target clears the whole chat, which EventSub already says in full.
func (w *FirstMessageWatcher) handleClearchat(line string) {
	tags := parseIRCTags(line)
	room, user := tags["room-id"], tags["target-user-id"]
	if room == "" || user == "" {
		return
	}
	seconds := 0
	if d, ok := tags["ban-duration"]; ok {
		n, err := strconv.Atoi(d)
		if err != nil || n <= 0 {
			return
		}
		seconds = n
	}
	w.OnClear(room, user, seconds)
}

// syncChannels keeps this connection's joins equal to the wanted set. A
// fresh connection starts with nothing joined, which is what rejoins every
// channel after a reconnect. Parts go out first and joins are paced.
func (w *FirstMessageWatcher) syncChannels(ctx context.Context, write func(string) error) error {
	joined := make(map[string]struct{})
	for {
		login, join, ok := w.nextChange(joined)
		if !ok {
			select {
			case <-ctx.Done():
				return nil
			case <-w.wake:
			}
			continue
		}
		if !join {
			if err := write("PART #" + login + "\r\n"); err != nil {
				return err
			}
			delete(joined, login)
			continue
		}
		if err := w.limiter.wait(ctx); err != nil {
			return nil
		}
		if err := write("JOIN #" + login + "\r\n"); err != nil {
			return err
		}
		joined[login] = struct{}{}
	}
}

// nextChange picks one channel to part, or failing that one to join, in
// name order so the sequence is deterministic.
func (w *FirstMessageWatcher) nextChange(joined map[string]struct{}) (login string, join bool, ok bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	var parts, joins []string
	for l := range joined {
		if _, want := w.channels[l]; !want {
			parts = append(parts, l)
		}
	}
	if len(parts) > 0 {
		return slices.Min(parts), false, true
	}
	for l := range w.channels {
		if _, done := joined[l]; !done {
			joins = append(joins, l)
		}
	}
	if len(joins) > 0 {
		return slices.Min(joins), true, true
	}
	return "", false, false
}

// joinLimiter is a sliding-window log: at most burst joins in any window.
// Only the active session's sync goroutine uses it, and it outlives
// sessions so a quick reconnect cannot double the rate.
type joinLimiter struct {
	burst  int
	window time.Duration
	sent   []time.Time
}

func (l *joinLimiter) wait(ctx context.Context) error {
	now := time.Now()
	cutoff := now.Add(-l.window)
	i := 0
	for i < len(l.sent) && !l.sent[i].After(cutoff) {
		i++
	}
	l.sent = l.sent[i:]
	if len(l.sent) >= l.burst {
		t := time.NewTimer(l.sent[0].Add(l.window).Sub(now))
		defer t.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case now = <-t.C:
		}
		l.sent = l.sent[1:]
	}
	l.sent = append(l.sent, now)
	return nil
}

// parseIRCTags decodes the IRCv3 message tags of a line, unescaping values
// per the spec. A line without tags yields an empty map.
func parseIRCTags(line string) map[string]string {
	tags := make(map[string]string)
	if !strings.HasPrefix(line, "@") {
		return tags
	}
	raw, _, _ := strings.Cut(line[1:], " ")
	for _, pair := range strings.Split(raw, ";") {
		if pair == "" {
			continue
		}
		key, value, _ := strings.Cut(pair, "=")
		tags[key] = unescapeTagValue(value)
	}
	return tags
}

func unescapeTagValue(v string) string {
	if !strings.Contains(v, `\`) {
		return v
	}
	var b strings.Builder
	b.Grow(len(v))
	for i := 0; i < len(v); i++ {
		c := v[i]
		if c != '\\' {
			b.WriteByte(c)
			continue
		}
		i++
		if i == len(v) {
			// A trailing lone backslash is dropped.
			break
		}
		switch v[i] {
		case ':':
			b.WriteByte(';')
		case 's':
			b.WriteByte(' ')
		case 'r':
			b.WriteByte('\r')
		case 'n':
			b.WriteByte('\n')
		default:
			// `\\` and any unknown escape keep the escaped character.
			b.WriteByte(v[i])
		}
	}
	return b.String()
}
