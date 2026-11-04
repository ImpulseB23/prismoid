package twitch

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

// How long Twitch gets to answer a login, a JOIN or a sent message. A
// message Twitch drops silently (it does that when you send too fast) would
// otherwise wait forever. Variables so tests can shorten them.
var (
	ircLoginTimeout  = 10 * time.Second
	ircJoinTimeout   = 5 * time.Second
	ircAnswerTimeout = 10 * time.Second
)

// ErrNoAnswer is a sent message Twitch neither confirmed nor refused.
var ErrNoAnswer = errors.New("twitch irc: no answer to the message")

// ErrLoginRefused is Twitch turning the token away, the IRC counterpart of
// a Helix 401.
var ErrLoginRefused = errors.New("twitch irc: login refused")

// ChatWriter sends the user's chat messages over one signed-in Twitch IRC
// connection, the way twitch.tv and Chatterino do: the socket stays open,
// so a message costs a write rather than an HTTPS request. Twitch answers a
// PRIVMSG with USERSTATE carrying the new message's id, or with a NOTICE
// whose msg-id says why it was refused.
//
// Sends are serialized: the answers carry no request id, so only one
// message may be waiting for its answer at a time.
type ChatWriter struct {
	// Addr overrides the Twitch IRC endpoint; "" uses the default.
	Addr string
	// Dial overrides the TLS dial; tests point it at a plain listener.
	Dial func(ctx context.Context, addr string) (net.Conn, error)
	Log  zerolog.Logger

	mu   sync.Mutex
	conn *writerConn
}

// SendResult is Twitch's answer: the new message's id, or why it was
// refused.
type SendResult struct {
	MessageID   string
	DropCode    string
	DropMessage string
}

type writerConn struct {
	conn   net.Conn
	login  string
	token  string
	joined map[string]bool
	lines  chan string
	done   chan struct{}

	writeMu sync.Mutex
}

// Send posts text to channel (a login) as the signed-in user and waits for
// Twitch's answer. replyParent, if set, makes it a reply.
func (w *ChatWriter) Send(ctx context.Context, login, token, channel, text, replyParent string) (SendResult, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	c, err := w.connection(ctx, login, token)
	if err != nil {
		return SendResult{}, err
	}
	channel = strings.ToLower(channel)
	if err := c.join(ctx, channel); err != nil {
		w.drop(c)
		return SendResult{}, err
	}
	// An answer that arrived after an earlier send gave up must not be
	// read as this message's.
	c.drain()

	line := fmt.Sprintf("PRIVMSG #%s :%s\r\n", channel, oneLine(text))
	if replyParent != "" {
		line = "@reply-parent-msg-id=" + replyParent + " " + line
	}
	if err := c.write(line); err != nil {
		w.drop(c)
		return SendResult{}, fmt.Errorf("write: %w", err)
	}

	timer := time.NewTimer(ircAnswerTimeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return SendResult{}, ctx.Err()
		case <-timer.C:
			return SendResult{}, ErrNoAnswer
		case <-c.done:
			w.drop(c)
			return SendResult{}, errors.New("twitch irc: connection closed before the answer")
		case l := <-c.lines:
			if ircChannel(l) != channel {
				continue
			}
			tags := parseIRCTags(l)
			switch ircCommand(l) {
			case "USERSTATE":
				if id := tags["id"]; id != "" {
					return SendResult{MessageID: id}, nil
				}
			case "NOTICE":
				if code := tags["msg-id"]; strings.HasPrefix(code, "msg_") {
					return SendResult{DropCode: code, DropMessage: ircTrailing(l)}, nil
				}
			}
		}
	}
}

// Close drops the connection; the next Send opens a new one.
func (w *ChatWriter) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.conn != nil {
		w.drop(w.conn)
	}
}

func (w *ChatWriter) drop(c *writerConn) {
	_ = c.conn.Close()
	if w.conn == c {
		w.conn = nil
	}
}

// connection returns a live connection signed in as login with token,
// opening a new one when there is none, it died, or the token changed.
func (w *ChatWriter) connection(ctx context.Context, login, token string) (*writerConn, error) {
	if c := w.conn; c != nil {
		select {
		case <-c.done:
			w.drop(c)
		default:
			if c.login == login && c.token == token {
				return c, nil
			}
			w.drop(c)
		}
	}
	conn, err := dialIRC(ctx, w.Addr, w.Dial)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	c := &writerConn{
		conn:   conn,
		login:  login,
		token:  token,
		joined: make(map[string]bool),
		lines:  make(chan string, 64),
		done:   make(chan struct{}),
	}
	go c.read(w.Log)
	if err := c.write(fmt.Sprintf("CAP REQ :twitch.tv/tags twitch.tv/commands\r\nPASS oauth:%s\r\nNICK %s\r\n", token, login)); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("handshake: %w", err)
	}
	if err := c.await(ctx, ircLoginTimeout, func(l string) (bool, error) {
		switch ircCommand(l) {
		case "001":
			return true, nil
		case "NOTICE":
			return false, fmt.Errorf("%w: %s", ErrLoginRefused, ircTrailing(l))
		}
		return false, nil
	}); err != nil {
		_ = conn.Close()
		return nil, err
	}
	w.conn = c
	return c, nil
}

// join enters channel once per connection; Twitch answers a JOIN with the
// user's USERSTATE there.
func (c *writerConn) join(ctx context.Context, channel string) error {
	if c.joined[channel] {
		return nil
	}
	if err := c.write("JOIN #" + channel + "\r\n"); err != nil {
		return fmt.Errorf("join: %w", err)
	}
	if err := c.await(ctx, ircJoinTimeout, func(l string) (bool, error) {
		return ircCommand(l) == "USERSTATE" && ircChannel(l) == channel, nil
	}); err != nil {
		return fmt.Errorf("join %s: %w", channel, err)
	}
	c.joined[channel] = true
	return nil
}

// await reads lines until done says so, it fails, or timeout passes.
func (c *writerConn) await(ctx context.Context, timeout time.Duration, done func(string) (bool, error)) error {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errors.New("twitch irc: timed out")
		case <-c.done:
			return errors.New("twitch irc: connection closed")
		case l := <-c.lines:
			ok, err := done(l)
			if err != nil {
				return err
			}
			if ok {
				return nil
			}
		}
	}
}

func (c *writerConn) drain() {
	for {
		select {
		case <-c.lines:
		default:
			return
		}
	}
}

func (c *writerConn) write(s string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err := io.WriteString(c.conn, s)
	return err
}

// read answers PINGs and hands Twitch's answers to the waiting send; it
// ends, closing done, when the socket fails or Twitch asks to reconnect.
func (c *writerConn) read(log zerolog.Logger) {
	defer close(c.done)
	defer func() { _ = c.conn.Close() }()
	rd := bufio.NewReaderSize(c.conn, 64*1024)
	for {
		if err := c.conn.SetReadDeadline(time.Now().Add(ircReadTimeout)); err != nil {
			return
		}
		line, err := rd.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		switch ircCommand(line) {
		case "PING":
			if c.write("PONG :tmi.twitch.tv\r\n") != nil {
				return
			}
		case "RECONNECT":
			log.Info().Msg("irc writer asked to reconnect")
			return
		// Joined channels' chat also arrives here; only the answers a send
		// waits for are passed on, so a busy chat can never crowd one out.
		case "001", "USERSTATE", "NOTICE":
			select {
			case c.lines <- line:
			default:
				log.Warn().Msg("irc writer answer buffer full, dropping a line")
			}
		}
	}
}

// ircChannel returns the channel login a line is about, from its first
// "#name" parameter, or "".
func ircChannel(line string) string {
	i := strings.Index(line, " #")
	if i < 0 {
		return ""
	}
	name, _, _ := strings.Cut(line[i+2:], " ")
	return name
}

// ircTrailing returns a line's trailing parameter, the text after " :".
func ircTrailing(line string) string {
	rest := line
	if strings.HasPrefix(rest, "@") {
		_, rest, _ = strings.Cut(rest, " ")
	}
	if strings.HasPrefix(rest, ":") {
		_, rest, _ = strings.Cut(rest, " ")
	}
	_, trailing, _ := strings.Cut(rest, " :")
	return trailing
}

// oneLine keeps a message to a single IRC line.
func oneLine(text string) string {
	return strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ").Replace(text)
}
