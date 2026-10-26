package twitch

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"strings"
	"time"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/backoff"
	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
)

const defaultIRCAddr = "irc.chat.twitch.tv:6697"

// Twitch pings roughly every five minutes; a quiet connection past this is
// dead.
const ircReadTimeout = 6 * time.Minute

var errIRCReconnect = errors.New("twitch irc: server asked to reconnect")

// Reader follows one channel's chat over Twitch IRC without signing in, the
// way every third-party client reads anonymously (a `justinfan` nick and no
// password). EventSub refuses chat subscriptions for an account that is
// banned or timed out in the channel while IRC keeps delivering, so this is
// the read path for those channels. Lines go to Out raw, tagged
// [control.TagTwitchIRC]; the host parses them.
type Reader struct {
	ChannelLogin string
	// Addr overrides the Twitch IRC endpoint; "" uses the default.
	Addr string
	// Dial overrides the TLS dial; tests point it at a plain listener.
	Dial func(ctx context.Context, addr string) (net.Conn, error)

	Out chan<- []byte
	Log zerolog.Logger
}

// Run reads until ctx is cancelled, reconnecting with backoff on any
// failure and at once when the server asks.
func (r *Reader) Run(ctx context.Context) error {
	bo := backoff.New(time.Second, 30*time.Second)
	for {
		err := r.session(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(err, errIRCReconnect) {
			bo.Reset()
			continue
		}
		r.Log.Warn().Err(err).Msg("irc disconnected, reconnecting")
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(bo.Next()):
		}
	}
}

func (r *Reader) session(ctx context.Context) error {
	conn, err := r.dial(ctx)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer func() { _ = conn.Close() }()
	// Closing the socket is what unblocks a pending read on cancellation.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()

	nick := fmt.Sprintf("justinfan%d", 10000+rand.IntN(90000))
	if _, err := fmt.Fprintf(conn, "CAP REQ :twitch.tv/tags twitch.tv/commands\r\nNICK %s\r\nJOIN #%s\r\n", nick, r.ChannelLogin); err != nil {
		return fmt.Errorf("handshake: %w", err)
	}
	r.Log.Info().Str("channel", r.ChannelLogin).Msg("reading chat over irc")

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
			if _, err := io.WriteString(conn, "PONG :tmi.twitch.tv\r\n"); err != nil {
				return fmt.Errorf("pong: %w", err)
			}
		case "RECONNECT":
			return errIRCReconnect
		case "PRIVMSG", "USERNOTICE", "CLEARCHAT", "CLEARMSG":
			r.forward(line)
		case "NOTICE":
			r.Log.Info().Str("line", line).Msg("irc notice")
		}
	}
}

func (r *Reader) dial(ctx context.Context) (net.Conn, error) {
	addr := r.Addr
	if addr == "" {
		addr = defaultIRCAddr
	}
	if r.Dial != nil {
		return r.Dial(ctx, addr)
	}
	return (&tls.Dialer{}).DialContext(ctx, "tcp", addr)
}

// forward hands a line to the ring writer. Same drop-newest rule as the
// EventSub client: a full channel means the ring is full too, and stalling
// the socket read would only make Twitch drop us.
func (r *Reader) forward(line string) {
	tagged := make([]byte, 1+len(line))
	tagged[0] = control.TagTwitchIRC
	copy(tagged[1:], line)
	select {
	case r.Out <- tagged:
	default:
		r.Log.Warn().Msg("output channel full, dropping irc line")
	}
}

// ircCommand returns the command word of a line, past any tags and prefix.
func ircCommand(line string) string {
	rest := line
	if strings.HasPrefix(rest, "@") {
		_, after, ok := strings.Cut(rest, " ")
		if !ok {
			return ""
		}
		rest = strings.TrimLeft(after, " ")
	}
	if strings.HasPrefix(rest, ":") {
		_, after, ok := strings.Cut(rest, " ")
		if !ok {
			return ""
		}
		rest = strings.TrimLeft(after, " ")
	}
	cmd, _, _ := strings.Cut(rest, " ")
	return cmd
}
