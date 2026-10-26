package twitch

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
)

// ircServer accepts connections and hands each one to handle on its own
// goroutine. Tests drive the conversation from inside handle.
func ircServer(t *testing.T, handle func(conn net.Conn, n int)) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for n := 1; ; n++ {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handle(conn, n)
		}
	}()
	return ln
}

func newTestReader(addr string, out chan<- []byte) *Reader {
	return &Reader{
		ChannelLogin: "forsen",
		Addr:         addr,
		Dial: func(ctx context.Context, addr string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", addr)
		},
		Out: out,
		Log: zerolog.Nop(),
	}
}

func readLines(t *testing.T, rd *bufio.Reader, n int) []string {
	t.Helper()
	lines := make([]string, 0, n)
	for range n {
		line, err := rd.ReadString('\n')
		if err != nil {
			t.Errorf("read handshake: %v", err)
			return lines
		}
		lines = append(lines, strings.TrimRight(line, "\r\n"))
	}
	return lines
}

func TestReaderHandshakesAnonymouslyAndForwardsChatLines(t *testing.T) {
	const privmsg = "@id=m1;room-id=1;tmi-sent-ts=5;user-id=7 :alice!alice@alice.tmi.twitch.tv PRIVMSG #forsen :hi"
	gotPong := make(chan string, 1)
	ln := ircServer(t, func(conn net.Conn, _ int) {
		defer func() { _ = conn.Close() }()
		rd := bufio.NewReader(conn)
		lines := readLines(t, rd, 3)
		if len(lines) != 3 || lines[0] != "CAP REQ :twitch.tv/tags twitch.tv/commands" ||
			!strings.HasPrefix(lines[1], "NICK justinfan") || lines[2] != "JOIN #forsen" {
			t.Errorf("unexpected handshake: %q", lines)
		}
		_, _ = conn.Write([]byte("@room-id=1 :tmi.twitch.tv ROOMSTATE #forsen\r\n"))
		_, _ = conn.Write([]byte("PING :tmi.twitch.tv\r\n"))
		pong, _ := rd.ReadString('\n')
		gotPong <- strings.TrimRight(pong, "\r\n")
		_, _ = conn.Write([]byte(privmsg + "\r\n"))
		time.Sleep(200 * time.Millisecond)
	})

	out := make(chan []byte, 16)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- newTestReader(ln.Addr().String(), out).Run(ctx) }()

	select {
	case pong := <-gotPong:
		if pong != "PONG :tmi.twitch.tv" {
			t.Fatalf("unexpected pong: %q", pong)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no PONG")
	}

	select {
	case msg := <-out:
		if msg[0] != control.TagTwitchIRC || string(msg[1:]) != privmsg {
			t.Fatalf("unexpected forwarded line: %x %q", msg[0], msg[1:])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("PRIVMSG was not forwarded")
	}
	select {
	case msg := <-out:
		t.Fatalf("ROOMSTATE should not be forwarded, got %q", msg[1:])
	default:
	}

	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
}

func TestReaderReconnectsWhenAsked(t *testing.T) {
	var dials atomic.Int32
	second := make(chan struct{}, 1)
	ln := ircServer(t, func(conn net.Conn, n int) {
		defer func() { _ = conn.Close() }()
		dials.Add(1)
		rd := bufio.NewReader(conn)
		readLines(t, rd, 3)
		if n == 1 {
			_, _ = conn.Write([]byte(":tmi.twitch.tv RECONNECT\r\n"))
			return
		}
		second <- struct{}{}
		time.Sleep(200 * time.Millisecond)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = newTestReader(ln.Addr().String(), make(chan []byte, 1)).Run(ctx) }()

	select {
	case <-second:
	case <-time.After(3 * time.Second):
		t.Fatal("no second connection after RECONNECT")
	}
	if dials.Load() != 2 {
		t.Fatalf("expected 2 connections, got %d", dials.Load())
	}
}

func TestIRCCommand(t *testing.T) {
	cases := map[string]string{
		"PING :tmi.twitch.tv":                    "PING",
		":tmi.twitch.tv RECONNECT":               "RECONNECT",
		"@a=b;c=d :x!x@x PRIVMSG #c :hi":         "PRIVMSG",
		"@room-id=1 :tmi.twitch.tv CLEARCHAT #c": "CLEARCHAT",
		"@only=tags":                             "",
		":prefix-only":                           "",
		"@a=b  :x!x@x   USERNOTICE #c":           "USERNOTICE",
	}
	for line, want := range cases {
		if got := ircCommand(line); got != want {
			t.Errorf("%q: got %q want %q", line, got, want)
		}
	}
}
