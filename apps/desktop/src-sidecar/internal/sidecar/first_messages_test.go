package sidecar

import (
	"bufio"
	"context"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"github.com/ImpulseB23/Prismoid/sidecar/internal/control"
)

func idleFirsts() *firstMessages {
	return newFirstMessages(context.Background(), func(string, any) {}, zerolog.Nop())
}

func TestTwitchConnectTracksLoginForFirstMessages(t *testing.T) {
	restore := stubEmoteFetcher(t)
	defer restore()

	clients := make(map[string]context.CancelFunc)
	session := idleSession(t)
	firsts := idleFirsts()
	out := make(chan []byte, 1)
	nop := func(string, any) {}

	HandleTwitchConnect(context.Background(), control.Command{BroadcasterID: "1", ChannelLogin: "forsen"}, clients, session, firsts, idleCosmetics(t), idleBundles(), out, nop, zerolog.Nop())
	HandleTwitchConnect(context.Background(), control.Command{BroadcasterID: "2"}, clients, session, firsts, idleCosmetics(t), idleBundles(), out, nop, zerolog.Nop())
	if len(firsts.logins) != 1 || firsts.logins["1"] != "forsen" {
		t.Fatalf("unexpected logins: %v", firsts.logins)
	}

	HandleTwitchDisconnect(control.Command{BroadcasterID: "1"}, clients, session, firsts, idleCosmetics(t), idleBundles(), zerolog.Nop())
	HandleTwitchDisconnect(control.Command{BroadcasterID: "2"}, clients, session, firsts, idleCosmetics(t), idleBundles(), zerolog.Nop())
	if len(firsts.logins) != 0 {
		t.Fatalf("logins left after disconnect: %v", firsts.logins)
	}
}

func TestFirstMessagesCommandStartsAndStopsWatcher(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	joined := make(chan string, 1)
	closed := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		rd := bufio.NewReader(conn)
		for range 3 {
			line, _ := rd.ReadString('\n')
			joined <- strings.TrimRight(line, "\r\n")
		}
		_, _ = conn.Write([]byte("@first-msg=1;id=m1;room-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #forsen :hi\r\n"))
		_, _ = io.Copy(io.Discard, rd)
		close(closed)
	}()

	notified := make(chan any, 1)
	firsts := newFirstMessages(context.Background(), func(msgType string, payload any) {
		if msgType == "first_message" {
			notified <- payload
		}
	}, zerolog.Nop())
	firsts.watcher.Addr = ln.Addr().String()
	firsts.watcher.Dial = func(ctx context.Context, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	}
	firsts.join("1", "forsen")

	dispatch := func(enabled bool) {
		DispatchCommand(context.Background(), control.Command{Cmd: "first_messages", Enabled: enabled},
			map[string]context.CancelFunc{}, idleSession(t), firsts, idleCosmetics(t), idleBundles(), make(chan []byte, 1), func(string, any) {}, zerolog.Nop())
	}
	dispatch(true)
	dispatch(true)

	var last string
	for range 3 {
		select {
		case last = <-joined:
		case <-time.After(3 * time.Second):
			t.Fatal("watcher did not handshake and join")
		}
	}
	if last != "JOIN #forsen" {
		t.Fatalf("expected JOIN #forsen, got %q", last)
	}

	select {
	case p := <-notified:
		if p != (FirstMessagePayload{ChannelID: "1", MessageID: "m1"}) {
			t.Fatalf("unexpected payload: %#v", p)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("first_message not sent")
	}

	dispatch(false)
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("connection still open after switching off")
	}
	if firsts.stop != nil {
		t.Fatal("watcher still marked running")
	}
	dispatch(false)
}
