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
	return newFirstMessages(func(string, any) {}, zerolog.Nop())
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

func TestWatcherReportsClearsAlwaysAndFirstsWhenSwitchedOn(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	joined := make(chan string, 1)
	send := make(chan string)
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
		go func() { _, _ = io.Copy(io.Discard, rd) }()
		for line := range send {
			_, _ = conn.Write([]byte(line + "\r\n"))
		}
	}()

	type note struct {
		kind    string
		payload any
	}
	notes := make(chan note, 4)
	firsts := newFirstMessages(func(msgType string, payload any) {
		notes <- note{msgType, payload}
	}, zerolog.Nop())
	firsts.watcher.Addr = ln.Addr().String()
	firsts.watcher.Dial = func(ctx context.Context, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	}
	firsts.join("1", "forsen")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		firsts.run(ctx)
		close(done)
	}()
	defer func() {
		close(send)
		cancel()
		<-done
	}()

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

	next := func() note {
		t.Helper()
		select {
		case n := <-notes:
			return n
		case <-time.After(3 * time.Second):
			t.Fatal("nothing reported")
			return note{}
		}
	}
	dispatch := func(enabled bool) {
		DispatchCommand(context.Background(), control.Command{Cmd: "first_messages", Enabled: enabled},
			map[string]context.CancelFunc{}, idleSession(t), firsts, idleCosmetics(t), idleBundles(), make(chan []byte, 1), func(string, any) {}, zerolog.Nop())
	}

	// Off: the first message goes unreported, the ban after it still comes.
	send <- "@first-msg=1;id=m0;room-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #forsen :hi"
	send <- "@room-id=1;target-user-id=7 :tmi.twitch.tv CLEARCHAT #forsen :a"
	if n := next(); n.kind != "user_clear" || n.payload != (UserClearPayload{ChannelID: "1", TargetUserID: "7"}) {
		t.Fatalf("unexpected note: %#v", n)
	}

	dispatch(true)
	send <- "@first-msg=1;id=m1;room-id=1 :a!a@a.tmi.twitch.tv PRIVMSG #forsen :hi"
	if n := next(); n.kind != "first_message" || n.payload != (FirstMessagePayload{ChannelID: "1", MessageID: "m1"}) {
		t.Fatalf("unexpected note: %#v", n)
	}

	send <- "@ban-duration=60;room-id=1;target-user-id=8 :tmi.twitch.tv CLEARCHAT #forsen :b"
	n := next()
	p, ok := n.payload.(UserClearPayload)
	if n.kind != "user_clear" || !ok || p.TargetUserID != "8" || p.DurationSeconds == nil || *p.DurationSeconds != 60 {
		t.Fatalf("unexpected note: %#v", n)
	}
}
