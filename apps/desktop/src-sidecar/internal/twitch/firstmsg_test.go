package twitch

import (
	"bufio"
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

type firstMsg struct{ channel, id string }

type userClear struct {
	channel, user string
	seconds       int
}

func newTestWatcher(addr string, got chan<- firstMsg) *FirstMessageWatcher {
	return newClearWatcher(addr, got, make(chan userClear, 8))
}

func newClearWatcher(addr string, got chan<- firstMsg, clears chan<- userClear) *FirstMessageWatcher {
	w := NewFirstMessageWatcher(
		func(channel, id string) { got <- firstMsg{channel, id} },
		func(channel, user string, seconds int) { clears <- userClear{channel, user, seconds} },
		zerolog.Nop(),
	)
	w.Addr = addr
	w.Dial = func(ctx context.Context, addr string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	}
	return w
}

func runWatcher(t *testing.T, w *FirstMessageWatcher) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("expected context.Canceled, got %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("Run did not return after cancel")
		}
	})
}

func expectLines(t *testing.T, lines <-chan []string, want ...string) {
	t.Helper()
	select {
	case got := <-lines:
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("got %q want %q", got, want)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %q", want)
	}
}

func TestFirstMessageWatcherFollowsJoinsAndFlagsFirstMessages(t *testing.T) {
	lines := make(chan []string, 8)
	send := make(chan string, 8)
	defer close(send)
	ln := ircServer(t, func(conn net.Conn, _ int) {
		defer func() { _ = conn.Close() }()
		rd := bufio.NewReader(conn)
		hs := readLines(t, rd, 3)
		if len(hs) != 3 || hs[0] != "CAP REQ :twitch.tv/tags twitch.tv/commands" || !strings.HasPrefix(hs[1], "NICK justinfan") {
			t.Errorf("unexpected handshake: %q", hs)
		}
		lines <- hs[2:]
		go func() {
			for s := range send {
				_, _ = conn.Write([]byte(s + "\r\n"))
			}
		}()
		for {
			l, err := rd.ReadString('\n')
			if err != nil {
				return
			}
			lines <- []string{strings.TrimRight(l, "\r\n")}
		}
	})

	got := make(chan firstMsg, 4)
	clears := make(chan userClear, 4)
	w := newClearWatcher(ln.Addr().String(), got, clears)
	w.Join("forsen")
	runWatcher(t, w)
	expectLines(t, lines, "JOIN #forsen")

	w.Join("xqc")
	expectLines(t, lines, "JOIN #xqc")
	w.Part("forsen")
	expectLines(t, lines, "PART #forsen")

	send <- "PING :tmi.twitch.tv"
	expectLines(t, lines, "PONG :tmi.twitch.tv")

	send <- "@id=a;room-id=1;first-msg=0 :a!a@a.tmi.twitch.tv PRIVMSG #xqc :hi"
	send <- "@id=b;room-id=1 :b!b@b.tmi.twitch.tv PRIVMSG #xqc :hi"
	send <- "@first-msg=1;id=c;room-id=1 :tmi.twitch.tv USERNOTICE #xqc"
	send <- "@first-msg=1;room-id=1 :d!d@d.tmi.twitch.tv PRIVMSG #xqc :no id"
	send <- "@badges=;first-msg=1;id=e;room-id=71092938 :e!e@e.tmi.twitch.tv PRIVMSG #xqc :hello"
	select {
	case m := <-got:
		if m != (firstMsg{"71092938", "e"}) {
			t.Fatalf("unexpected first message: %+v", m)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("first message not reported")
	}
	select {
	case m := <-got:
		t.Fatalf("only one first message expected, also got %+v", m)
	case <-time.After(50 * time.Millisecond):
	}

	send <- "@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #xqc"
	send <- "@ban-duration=x;room-id=1;target-user-id=8 :tmi.twitch.tv CLEARCHAT #xqc :f"
	send <- "@ban-duration=600;room-id=1;target-user-id=9 :tmi.twitch.tv CLEARCHAT #xqc :g"
	send <- "@room-id=1;target-user-id=10 :tmi.twitch.tv CLEARCHAT #xqc :h"
	for _, want := range []userClear{{"1", "9", 600}, {"1", "10", 0}} {
		select {
		case c := <-clears:
			if c != want {
				t.Fatalf("got clear %+v want %+v", c, want)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("clear %+v not reported", want)
		}
	}
}

func TestFirstMessageWatcherRejoinsAfterReconnect(t *testing.T) {
	lines := make(chan []string, 4)
	ln := ircServer(t, func(conn net.Conn, n int) {
		defer func() { _ = conn.Close() }()
		rd := bufio.NewReader(conn)
		lines <- readLines(t, rd, 4)[2:]
		if n == 1 {
			_, _ = conn.Write([]byte(":tmi.twitch.tv RECONNECT\r\n"))
			return
		}
		time.Sleep(200 * time.Millisecond)
	})

	w := newTestWatcher(ln.Addr().String(), make(chan firstMsg, 1))
	w.Join("b")
	w.Join("a")
	runWatcher(t, w)
	expectLines(t, lines, "JOIN #a", "JOIN #b")
	expectLines(t, lines, "JOIN #a", "JOIN #b")
}

func TestJoinLimiterPacesBursts(t *testing.T) {
	l := joinLimiter{burst: 2, window: 80 * time.Millisecond}
	ctx := context.Background()
	start := time.Now()
	for range 3 {
		if err := l.wait(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if elapsed := time.Since(start); elapsed < 70*time.Millisecond {
		t.Fatalf("third join went out after %v, inside the window", elapsed)
	}

	full := joinLimiter{burst: 1, window: time.Hour, sent: []time.Time{time.Now()}}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := full.wait(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestParseIRCTags(t *testing.T) {
	tags := parseIRCTags(`@a=1;b=x\:y\sz\\w\r\n;c=;d;e=tail\;f=\q :x!x@x PRIVMSG #c :hi`)
	want := map[string]string{
		"a": "1",
		"b": "x;y z\\w\r\n",
		"c": "",
		"d": "",
		"e": "tail",
		"f": "q",
	}
	if len(tags) != len(want) {
		t.Fatalf("got %q want %q", tags, want)
	}
	for k, v := range want {
		if tags[k] != v {
			t.Errorf("%s: got %q want %q", k, tags[k], v)
		}
	}
	if got := parseIRCTags(":x!x@x PRIVMSG #c :hi"); len(got) != 0 {
		t.Fatalf("untagged line gave %q", got)
	}
}
